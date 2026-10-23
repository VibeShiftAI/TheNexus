import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_DRAFT_MAX_AGE_MS,
  clearReviewDraft,
  readReviewDraft,
  reconcileReviewDraft,
  reviewDraftKey,
  writeReviewDraft,
  type LiveReviewComment,
  type LiveReviewState,
  type ReviewDraft,
} from '../review-drafts';

function memoryStore(options: { failWrites?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { if (options.failWrites) throw new DOMException('quota', 'QuotaExceededError'); map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

const NOW = Date.parse('2026-10-19T19:30:00.000Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function draft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    document_id: 'doc-1', revision_id: 'rev-1', content_hash: 'a'.repeat(64), reviewer_id: 'local_user', review_id: 'review-1',
    composer: { client_id: 'c-1', kind: 'passage', text: 'Tighten this.', block: { start: 7, end: 8 }, quote: '- alerting is manual' },
    edit: null, summary: null, recovered: [], saved_at: at(-1000), ...overrides,
  };
}

function live(overrides: Partial<LiveReviewState> = {}): LiveReviewState {
  return { document_id: 'doc-1', revision_id: 'rev-1', reviewer_id: 'local_user', review: { id: 'review-1', status: 'draft', summary: '', comments: [] }, ...overrides };
}

test('writes to the first store, reads it back, and clears both stores', () => {
  const local = memoryStore(); const session = memoryStore();
  assert.equal(writeReviewDraft('doc-1', draft(), [local, session]), true);
  assert.ok(local.map.has(reviewDraftKey('doc-1')));
  assert.equal(session.map.size, 0);
  const back = readReviewDraft('doc-1', [local, session], NOW);
  assert.equal(back?.composer?.text, 'Tighten this.');
  assert.deepEqual(back?.composer?.block, { start: 7, end: 8 });
  assert.equal(back?.reviewer_id, 'local_user');
  assert.equal(clearReviewDraft('doc-1', [local, session]), true);
  assert.equal(readReviewDraft('doc-1', [local, session], NOW), null);
});

test('falls back to the second store when the first refuses, and the newest copy wins on read', () => {
  const full = memoryStore({ failWrites: true }); const session = memoryStore();
  assert.equal(writeReviewDraft('doc-1', draft(), [full, session]), true);
  assert.ok(session.map.has(reviewDraftKey('doc-1')), 'sessionStorage holds the draft');
  assert.equal(writeReviewDraft('doc-1', draft(), [memoryStore({ failWrites: true }), memoryStore({ failWrites: true })]), false, 'no store at all is reported');
  const local = memoryStore();
  local.setItem(reviewDraftKey('doc-1'), JSON.stringify(draft({ composer: { client_id: 'c-old', kind: 'document', text: 'older' }, saved_at: at(-60_000) })));
  session.setItem(reviewDraftKey('doc-1'), JSON.stringify(draft({ composer: { client_id: 'c-new', kind: 'document', text: 'newer' }, saved_at: at(-1000) })));
  assert.equal(readReviewDraft('doc-1', [local, session], NOW)?.composer?.text, 'newer');
});

test('an empty draft clears storage; garbage, stale and textless records read as nothing', () => {
  const local = memoryStore();
  writeReviewDraft('doc-1', draft(), [local]);
  writeReviewDraft('doc-1', draft({ composer: null }), [local]);
  assert.equal(local.map.size, 0, 'nothing left once there is no text');
  local.setItem(reviewDraftKey('doc-1'), '{not json');
  assert.equal(readReviewDraft('doc-1', [local], NOW), null);
  local.setItem(reviewDraftKey('doc-1'), JSON.stringify(draft({ saved_at: at(-REVIEW_DRAFT_MAX_AGE_MS - 1) })));
  assert.equal(readReviewDraft('doc-1', [local], NOW), null, 'two-week-old drafts are ignored');
  local.setItem(reviewDraftKey('doc-1'), JSON.stringify(draft({ composer: { client_id: 'c', kind: 'document', text: '   ' } })));
  assert.equal(readReviewDraft('doc-1', [local], NOW), null, 'whitespace is not a draft');
  local.setItem(reviewDraftKey('doc-1'), JSON.stringify({ ...draft({ composer: null }), recovered: [{ id: 'r1', text: 'kept', label: 'Reply', reason: 'parent', revision_id: null, saved_at: at(-5) }] }));
  assert.equal(readReviewDraft('doc-1', [local], NOW)?.recovered[0]?.text, 'kept', 'recovered text alone keeps the record');
});

test('a draft for another document or another known reviewer is foreign; an unknown reviewer is not', () => {
  assert.equal(reconcileReviewDraft(draft({ document_id: 'doc-2' }), live()).foreign, true);
  assert.equal(reconcileReviewDraft(draft({ reviewer_id: 'someone-else' }), live()).foreign, true);
  assert.equal(reconcileReviewDraft(draft({ reviewer_id: null }), live()).foreign, false, 'written before the API reported the viewer');
  assert.equal(reconcileReviewDraft(draft(), live({ reviewer_id: null })).foreign, false, 'read from an API that does not report the viewer');
});

test('a passage comment goes back to its composer on the same revision and is recovered, not moved, on another', () => {
  assert.deepEqual(reconcileReviewDraft(draft(), live()).composer, { restore: draft().composer });
  const moved = reconcileReviewDraft(draft(), live({ revision_id: 'rev-2' })).composer;
  assert.ok(moved && 'recovered' in moved && moved.reason === 'revision');
  const note = draft({ composer: { client_id: 'c-2', kind: 'document', text: 'Overall fine.' } });
  assert.deepEqual(reconcileReviewDraft(note, live({ revision_id: 'rev-2' })).composer, { restore: note.composer }, 'a whole-document note is not tied to a revision');
});

test('a comment is done only when its own client id is on a saved comment; wording alone never discards a draft', () => {
  const withComments = (comments: LiveReviewComment[]) => live({ review: { id: 'review-1', status: 'draft', summary: '', comments } });
  const byId = reconcileReviewDraft(draft(), withComments([{ id: 'k1', body: 'something else', client_id: 'c-1' }])).composer;
  assert.deepEqual(byId, { saved: draft().composer, comment_id: 'k1' });
  // The QA probe of 2026-10-19: the same words saved on lines 7-8 under another client id, typed again on line 3.
  const elsewhere = draft({ composer: { client_id: 'c-9', kind: 'passage', text: 'Tighten this.', block: { start: 3, end: 3 }, quote: 'Restart survived the drill.' } });
  const sameWordsOtherPlace = reconcileReviewDraft(elsewhere, withComments([{ id: 'k2', body: 'Tighten this.', kind: 'passage', client_id: 'c-1', start_line: 7, end_line: 8, quote: '- alerting is manual' }])).composer;
  assert.deepEqual(sameWordsOtherPlace, { restore: elsewhere.composer }, 'a different client id at a different place is a different comment');
  const sameWordsSamePlace = reconcileReviewDraft(draft(), withComments([{ id: 'k2', body: 'Tighten this.', kind: 'passage', client_id: 'c-other', start_line: 7, end_line: 8, quote: '- alerting is manual' }])).composer;
  assert.deepEqual(sameWordsSamePlace, { restore: draft().composer }, 'the server reports client ids and this one is not among them: the save never landed');
  const otherKind = reconcileReviewDraft(draft(), withComments([{ id: 'k3', body: 'Tighten this.', kind: 'document' }])).composer;
  assert.deepEqual(otherKind, { restore: draft().composer }, 'same words on a different kind of comment are not the same comment');
});

test('without client ids from the API the draft is kept, and a same-text comment at the same place is only pointed out', () => {
  const legacy = (comments: LiveReviewComment[]) => live({ review: { id: 'review-1', status: 'draft', summary: '', comments } });
  const samePlace = reconcileReviewDraft(draft(), legacy([{ id: 'k2', body: 'Tighten this.', kind: 'passage', start_line: 7, end_line: 8, quote: '- alerting is manual' }])).composer;
  assert.deepEqual(samePlace, { restore: draft().composer, same_as: 'k2' }, 'identity cannot be confirmed: restored, with the twin named');
  const otherPlace = reconcileReviewDraft(draft(), legacy([{ id: 'k2', body: 'Tighten this.', kind: 'passage', start_line: 3, end_line: 3, quote: 'Restart survived the drill.' }])).composer;
  assert.deepEqual(otherPlace, { restore: draft().composer }, 'the same words elsewhere are not a twin');
  const note = draft({ composer: { client_id: 'c-2', kind: 'document', text: 'Overall fine.' } });
  assert.deepEqual(reconcileReviewDraft(note, legacy([{ id: 'k4', body: 'Overall fine.', kind: 'document' }])).composer, { restore: note.composer, same_as: 'k4' });
  assert.deepEqual(reconcileReviewDraft(note, legacy([{ id: 'k5', body: 'Overall fine.', kind: 'document', parent_id: 'k4' }])).composer, { restore: note.composer }, 'a reply with the same words is not a twin of a root note');
  const reply = draft({ composer: { client_id: 'c-3', kind: 'document', text: 'Agreed.', parent_id: 'k4' } });
  assert.deepEqual(reconcileReviewDraft(reply, legacy([{ id: 'k4', body: 'root' }, { id: 'k6', body: 'Agreed.', kind: 'document', parent_id: 'k4' }])).composer, { restore: reply.composer, same_as: 'k6' });
});

test('a finished review and a vanished parent turn the text into recovered text', () => {
  const finished = reconcileReviewDraft(draft(), live({ review: { id: 'review-1', status: 'submitted', summary: '', comments: [] } })).composer;
  assert.ok(finished && 'recovered' in finished && finished.reason === 'review');
  const reply = draft({ composer: { client_id: 'c-3', kind: 'document', text: 'Agreed.', parent_id: 'k9' } });
  const orphan = reconcileReviewDraft(reply, live()).composer;
  assert.ok(orphan && 'recovered' in orphan && orphan.reason === 'parent');
  const withParent = reconcileReviewDraft(reply, live({ review: { id: 'review-1', status: 'draft', summary: '', comments: [{ id: 'k9', body: 'root' }] } })).composer;
  assert.deepEqual(withParent, { restore: reply.composer });
});

test('an edit is restored only onto the comment it started from, and dropped once it is applied', () => {
  const edit = draft({ composer: null, edit: { comment_id: 'k1', base_body: 'old words', text: 'new words' } });
  const comments = (body: string) => ({ id: 'review-1', status: 'draft', summary: '', comments: [{ id: 'k1', body }] });
  assert.deepEqual(reconcileReviewDraft(edit, live({ review: comments('old words') })).edit, { restore: edit.edit });
  assert.equal(reconcileReviewDraft(edit, live({ review: comments('new words') })).edit, null, 'the edit landed before the reload');
  const changed = reconcileReviewDraft(edit, live({ review: comments('changed elsewhere') })).edit;
  assert.ok(changed && 'recovered' in changed && changed.reason === 'comment');
  const gone = reconcileReviewDraft(edit, live()).edit;
  assert.ok(gone && 'recovered' in gone && gone.reason === 'comment');
});

test('a summary is restored over the server copy it was typed on or continues, and dropped when the server moved past it', () => {
  const summary = (text: string, base: string) => draft({ composer: null, summary: { text, base } });
  const server = (value: string) => live({ review: { id: 'review-1', status: 'draft', summary: value, comments: [] } });
  assert.deepEqual(reconcileReviewDraft(summary('abc def', ''), server('')).summary, { restore: 'abc def' });
  assert.deepEqual(reconcileReviewDraft(summary('abc def', ''), server('abc')).summary, { restore: 'abc def' }, 'the autosave of "abc" landed, its reply did not');
  assert.equal(reconcileReviewDraft(summary('abc def', 'abc def'), server('abc def')).summary, null, 'nothing to restore');
  assert.equal(reconcileReviewDraft(summary('abc def', ''), server('from the phone')).summary, null, 'another device wrote a different summary');
  assert.equal(reconcileReviewDraft(summary('abc def', ''), live({ review: { id: 'review-1', status: 'submitted', summary: '', comments: [] } })).summary, null, 'a finished review takes no summary');
  assert.deepEqual(reconcileReviewDraft(summary('abc def', ''), live({ review: { id: 'review-1', status: 'superseded', summary: '', comments: [] } })).summary, { recovered: 'abc def', reason: 'review' }, 'a round closed as superseded never sent the text: kept, not dropped');
  assert.equal(reconcileReviewDraft(summary('abc', 'abc'), live({ review: { id: 'review-1', status: 'superseded', summary: 'abc', comments: [] } })).summary, null, 'a superseded round whose summary was saved has nothing to recover');
  assert.deepEqual(reconcileReviewDraft(summary('first thoughts', ''), live({ review: null })).summary, { restore: 'first thoughts' }, 'no review yet');
});
