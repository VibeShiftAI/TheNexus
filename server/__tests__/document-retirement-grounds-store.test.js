const Database = require('better-sqlite3');
const { initializeDocumentReviews, createDocumentReviewStore } = require('../../db/document-reviews');
const { readActivityEvents } = require('../../db/activity-events');
const { initializeDocumentRetirements } = require('../../db/document-retirements');

const message = 'nexus://conversation/fixture/message/ruling';
const grounds = [
    { type: 'chat_ruling', message_ref: message, answers: [{ decision_id: 'edition', answer: 'spring', message_ref: message }] },
    { type: 'purpose_changed', registration_id: 'registration-info', previous_purpose: 'Choose the edition', purpose: 'For information' },
    { type: 'revision_task_cancelled', replacement_id: 'attempt-1', task_id: 'revise-task' },
];

let db, store, target;
beforeEach(() => {
    db = new Database(':memory:');
    initializeDocumentReviews(db);
    store = createDocumentReviewStore(db);
    target = store.insertDocument({ path: '/fixture/edition.md', title: 'Spring edition', requires_review: true, intended_action: 'send' });
});
afterEach(() => db.close());

test.each(grounds)('$type records its ground and one informational activity, and a replay respects reopening', ground => {
    const retirement = store.retireOnGround({ target, ground });
    expect(retirement).toMatchObject({
        document_id: target.id, ground, trigger: ground.type, replaced_by_document_id: null,
        previous: { requires_review: true, review_status: 'needs_review', list_bucket: 'needs_review', intended_action: 'send' },
    });
    expect(store.getDocument(target.id)).toMatchObject({ requires_review: false, intended_action: 'send' });
    expect(store.getReviewStatus(target.id)).toBe('reference');
    expect(store.retireOnGround({ target, ground })).toBeNull();
    const [event] = readActivityEvents(db);
    expect(event).toMatchObject({ requires_action: 0, metadata: { retirement_id: retirement.id, document_id: target.id } });
    expect(event.title).toContain(target.title);
    expect(event.title).toContain(ground.message_ref || ground.registration_id || ground.task_id);
    expect(event.message).toContain(ground.message_ref || ground.registration_id || ground.task_id);
    expect(() => db.prepare('UPDATE review_document_retirements SET ground = NULL WHERE id = ?').run(retirement.id)).toThrow(/immutable/);
    store.reopenRetirement(target.id, 'Robert');
    store.updateDocument(target.id, { requires_review: true });
    expect(store.retireOnGround({ target, ground })).toBeNull();
    expect(store.getReviewStatus(target.id)).toBe('needs_review');
    expect(store.listRetirements(target.id)).toHaveLength(1);
    expect(readActivityEvents(db)).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM review_document_decisions').get().n).toBe(0);
});

test('guards reread the document and leave a cited ground retryable', () => {
    const revision = store.insertRevision({ document_id: target.id, content: 'edition', content_hash: 'fixture', byte_length: 7, line_count: 1 });
    store.setCurrentRevision(target.id, revision.id);
    const review = store.insertReview({ document_id: target.id, revision_id: revision.id, reviewer_id: 'Robert', summary: 'Keep this draft' });
    expect(store.retireOnGround({ target, ground: grounds[0] })).toBeNull();
    expect(store.listRetirements(target.id)).toEqual([]);
    expect(readActivityEvents(db)).toEqual([]);
    expect(store.getReviewStatus(target.id)).toBe('needs_review');
    store.updateReview(review.id, { summary: '' });
    expect(store.retireOnGround({ target, ground: grounds[0] }).previous.current_revision_id).toBe(revision.id);
});

test('an activity write failure rolls the retirement and bucket change back together', () => {
    db.exec("CREATE TRIGGER fail_feed BEFORE INSERT ON ag_events BEGIN SELECT raise(ABORT, 'fixture failure'); END");
    expect(() => store.retireOnGround({ target, ground: grounds[1] })).toThrow(/fixture failure/);
    expect(store.listRetirements(target.id)).toEqual([]);
    expect(store.getReviewStatus(target.id)).toBe('needs_review');
    db.exec('DROP TRIGGER fail_feed');
    expect(store.retireOnGround({ target, ground: grounds[1] })).toBeTruthy();
    expect(readActivityEvents(db)).toHaveLength(1);
});

test('the legacy predecessor table migrates once, preserving open and reopened records and their row order', () => {
    db.exec(`DROP TABLE review_document_retirements;
        CREATE TABLE review_document_retirements (
            id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES review_documents(id) ON DELETE CASCADE,
            replaced_by_document_id TEXT NOT NULL, replaced_by_revision_id TEXT, supersession_id TEXT NOT NULL,
            registration_id TEXT, task_id TEXT, named_by TEXT NOT NULL, named_value TEXT NOT NULL,
            trigger TEXT NOT NULL CHECK (trigger IN ('registration', 'review_requested', 'ready')),
            retired_by TEXT NOT NULL, retired_at TEXT NOT NULL, previous TEXT NOT NULL, reopened_at TEXT, reopened_by TEXT,
            reopened_via TEXT CHECK (reopened_via IS NULL OR reopened_via IN ('request_review','registration')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE UNIQUE INDEX idx_review_document_retirements_open ON review_document_retirements(document_id) WHERE reopened_at IS NULL;`);
    const insert = db.prepare(`INSERT INTO review_document_retirements VALUES
        (?, ?, 'successor', 'revision-2', 'supersession', 'reg-1', 'task-1', 'document_id', ?, 'ready', 'producer',
        '2026-11-16', '{"requires_review":true}', ?, ?, ?, '2026-11-16', '2026-11-16')`);
    insert.run('first', target.id, target.id, '2026-11-17', 'Robert', 'request_review');
    insert.run('second', target.id, target.id, null, null, null);
    const before = db.prepare('SELECT * FROM review_document_retirements ORDER BY rowid DESC').all();
    initializeDocumentRetirements(db);
    initializeDocumentRetirements(db);
    expect(store.listRetirements(target.id)).toEqual(before.map(row => ({ ...row, ground: null, previous: JSON.parse(row.previous) })));
    expect(store.findOpenRetirement(target.id).id).toBe('second');
    expect(() => db.exec("UPDATE review_document_retirements SET supersession_id = 'changed'")).toThrow(/immutable/);
    expect(() => db.exec("UPDATE review_document_retirements SET reopened_by = 'agent' WHERE id = 'first'")).toThrow(/reopened once/);
    store.reopenRetirement(target.id, 'Robert');
    expect(store.retireOnGround({ target, ground: grounds[2] }).trigger).toBe('revision_task_cancelled');
    expect(readActivityEvents(db)).toHaveLength(1);
});


test('the predecessor path writes one activity line naming both documents and the declared identity', () => {
    const successor = store.insertDocument({ path: '/fixture/summer.md', title: 'Summer edition', requires_review: true });
    const name = store.declareSupersession({ document_id: successor.id, named_by: 'document_id', named_value: target.id, declared_by: 'fixture-agent' });
    const retirement = store.retireDocument({ target, successor, supersession: name, trigger: 'registration', bucket: 'needs_review' });
    expect(store.getSupersession(name.id)).toMatchObject({ outcome: 'retired', retirement_id: retirement.id });
    const events = readActivityEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].title).toContain(target.title);
    expect(events[0].title).toContain(successor.title);
    expect(events[0].message).toContain(name.named_value);
});

test.each([
    { type: 'task_completed', task_id: 'unrelated-task' },
    { ...grounds[0], answers: [] },
    { ...grounds[1], previous_purpose: undefined },
    { ...grounds[2], task_id: '' },
])('a missing or unsupported citation cannot create a retirement', ground => {
    expect(store.retireOnGround({ target, ground })).toBeNull();
    expect(store.getReviewStatus(target.id)).toBe('needs_review');
    expect(readActivityEvents(db)).toEqual([]);
});
