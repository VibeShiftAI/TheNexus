// Exercise the board write directly. No document read or Praxis sweep should
// be needed to retire a review when its only revision task is cancelled.
const { randomUUID, createHash } = require('node:crypto');

let db;
let store;
let projectId;
let previousDb;

beforeAll(async () => {
    previousDb = process.env.NEXUS_DB_PATH;
    process.env.NEXUS_DB_PATH = ':memory:';
    db = require('../../db');
    store = db.documentReviews;
    projectId = randomUUID();
    await db.upsertProject({ id: projectId, name: 'Fixture project', path: '/fixture' });
});
afterAll(() => {
    if (previousDb === undefined) delete process.env.NEXUS_DB_PATH;
    else process.env.NEXUS_DB_PATH = previousDb;
});

function capture(documentId, content) {
    return store.insertRevision({ document_id: documentId, content,
        content_hash: createHash('sha256').update(content).digest('hex'),
        byte_length: Buffer.byteLength(content), line_count: 1 });
}

async function fixture(status = 'in_progress') {
    const task = await db.createTask({ id: randomUUID(), project_id: projectId, name: 'Revise preview', status });
    const doc = store.insertDocument({ path: '/fixture/' + randomUUID() + '.md', title: 'Preview',
        purpose: 'Client status report', requires_review: true, project_id: projectId });
    const revision = capture(doc.id, '# Status report\n');
    store.setCurrentRevision(doc.id, revision.id);
    const review = store.insertReview({ document_id: doc.id, revision_id: revision.id, reviewer_id: 'operator',
        summary: 'Regenerate the preview for the next report.', status: 'submitted', submitted_at: new Date().toISOString() });
    const replacement = store.insertReplacement({ document_id: doc.id, base_revision_id: revision.id,
        client_request_id: review.id, source_review_id: review.id, task_id: task.id, accepted_by: 'praxis' });
    return { task, doc, revision, replacement };
}

test('the task write closes its replacement and retires the review once, even when replayed after reopening', async () => {
    const { task, doc, revision, replacement } = await fixture();
    expect(await db.updateTask(task.id, { status: 'canceled' })).toMatchObject({ status: 'cancelled' });
    expect(store.getReplacement(replacement.id)).toMatchObject({ state: 'cancelled', result_revision_id: null });
    expect(store.getReviewStatus(doc.id)).toBe('reference');
    const retired = store.findOpenRetirement(doc.id);
    expect(retired.ground).toMatchObject({ type: 'revision_task_cancelled', task_id: task.id, replacement_id: replacement.id });
    expect(retired.previous.current_revision_id).toBe(revision.id);
    expect(store.listDecisions(doc.id)).toEqual([]);

    store.reopenRetirement(doc.id, 'operator');
    store.updateDocument(doc.id, { requires_review: true });
    await db.updateTask(task.id, { status: 'cancelled' });
    expect(store.getReviewStatus(doc.id)).toBe('needs_review');
    expect(store.listRetirements(doc.id).map(row => row.id)).toEqual([retired.id]);
});

test.each(['current decision', 'new version', 'registered result', 'independent feedback', 'intended action', 'purpose ask', 'draft comment'])(
    '%s keeps the review when the linked task is cancelled', async reason => {
        const { task, doc, revision, replacement } = await fixture();
        if (reason === 'current decision') store.insertDecision({ document_id: doc.id, revision_id: revision.id,
            decision: 'request_changes', content_hash: revision.content_hash, actor_id: 'operator', authority: 'operator_credential' });
        if (reason === 'new version' || reason === 'registered result') {
            const next = capture(doc.id, '# Next version');
            store.setCurrentRevision(doc.id, next.id);
            if (reason === 'registered result') store.updateReplacement(replacement.id, { result_revision_id: next.id });
        }
        if (reason === 'independent feedback') store.insertReview({ document_id: doc.id, revision_id: revision.id, reviewer_id: 'another-reviewer',
            summary: 'Correct the total in the first row.', status: 'submitted', submitted_at: new Date().toISOString() });
        if (reason === 'intended action') store.updateDocument(doc.id, { intended_action: 'send' });
        if (reason === 'purpose ask') store.updateDocument(doc.id, { purpose: 'Please choose the next release date.' });
        if (reason === 'draft comment') {
            const draft = store.insertReview({ document_id: doc.id, revision_id: revision.id, reviewer_id: 'another-reviewer' });
            store.insertComment({ review_id: draft.id, kind: 'document', body: 'Check the third row.' });
        }

        await db.updateTask(task.id, { status: 'cancelled' });
        expect(store.getReplacement(replacement.id).state).toBe('cancelled');
        expect(store.getDocument(doc.id).requires_review).toBe(true);
        expect(store.listRetirements(doc.id)).toEqual([]);
    },
);

test('linking an already cancelled board task, then replaying its status, supplies no retirement ground', async () => {
    const { doc, task } = await fixture('cancelled');
    await db.updateTask(task.id, { status: 'cancelled' });
    expect(store.listRetirements(doc.id)).toEqual([]);
    expect(store.getDocument(doc.id).requires_review).toBe(true);
});
