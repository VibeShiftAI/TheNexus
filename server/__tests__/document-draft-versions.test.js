const {
  primaryDraftNumber,
  groupDocumentDrafts,
  reconcileDocumentDrafts,
} = require("../../db/document-draft-versions");
const capture = (n, label, extra = {}) => ({
  id: `r${n}`,
  document_id: "doc",
  content_hash: `hash${n}`,
  content: label
    ? `# Outline\n\n*Proposed outline · v${label} (shown as v99 in Nexus), revised from v1*`
    : "# Outline\n\nText",
  captured_at: `2026-11-01T00:00:${String(n).padStart(2, "0")}.000Z`,
  source: "capture",
  ...extra,
});
test("primary document draft label excludes parenthetical platform counts and historical mentions", () => {
  expect(primaryDraftNumber(capture(1, 5).content)).toBe(5);
  expect(
    primaryDraftNumber("# Outline\n\nThis discusses API v8 and prior v2."),
  ).toBeNull();
  expect(primaryDraftNumber("# Outline\n\nVersion: 3")).toBe(3);
  expect(
    primaryDraftNumber("# Outline\n\n*Proposed outline · October 29, 2026*"),
  ).toBeNull();
});
test("nine captures remain five editorial drafts and intermediate captures remain addressable", () => {
  const revisions = [
    capture(1),
    capture(2, 2),
    capture(3, 2),
    capture(4, 3),
    capture(5, 3),
    capture(6, 3),
    capture(7, 4),
    capture(8, 4),
    capture(9, 5),
  ];
  const replacements = [
    [1, 3],
    [3, 5],
    [5, 8],
    [8, 9],
  ].map(([a, b]) => ({
    id: `work${b}`,
    base_revision_id: `r${a}`,
    result_revision_id: `r${b}`,
    state: "ready",
  }));
  const result = groupDocumentDrafts({
    documentId: "doc",
    revisions,
    replacements,
    registrations: [],
    currentRevisionId: "r9",
  });
  expect(result.revisions.map((r) => r.version)).toEqual([
    1, 2, 2, 3, 3, 3, 4, 4, 5,
  ]);
  expect(result.revisions.map((r) => r.capture_number)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
  expect(result.drafts.map((r) => r.id)).toEqual([
    "r1",
    "r3",
    "r5",
    "r8",
    "r9",
  ]);
  expect(result.drafts.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
  expect(result.revisions[5].is_delivered).toBe(false);
});
test("unlabeled working saves group by delivered replacement, not each capture", () => {
  const revisions = [capture(1), capture(2), capture(3), capture(4)];
  const result = groupDocumentDrafts({
    documentId: "doc",
    revisions,
    replacements: [
      {
        id: "work",
        base_revision_id: "r1",
        result_revision_id: "r3",
        state: "ready",
      },
    ],
    registrations: [],
    currentRevisionId: "r4",
  });
  expect(result.revisions.map((r) => r.version)).toEqual([1, 2, 2, 2]);
  expect(result.drafts).toHaveLength(2);
  expect(result.drafts[1].id).toBe("r4");
});
test("open replacement captures do not become delivered selector entries", () => {
  const result = groupDocumentDrafts({
    documentId: "doc",
    revisions: [capture(1), capture(2, 2)],
    replacements: [
      {
        id: "work",
        base_revision_id: "r1",
        result_revision_id: "r2",
        state: "running",
      },
    ],
    registrations: [],
    currentRevisionId: "r2",
  });
  expect(result.revisions).toHaveLength(2);
  expect(result.drafts.map((r) => r.id)).toEqual(["r1"]);
});
test("applying suggestions stays in the same editorial draft and preserves old exact references", () => {
  const revisions = [
    capture(1, 5),
    capture(2, 5, { source: "agent_review_apply" }),
  ];
  const result = groupDocumentDrafts({
    documentId: "doc",
    revisions,
    replacements: [],
    registrations: [],
    currentRevisionId: "r2",
  });
  expect(result.drafts).toHaveLength(1);
  expect(result.drafts[0].version).toBe(5);
  expect(result.drafts[0].id).toBe("r2");
  expect(result.revisions[0].content_hash).toBe("hash1");
});
test("unlabeled repeated handoffs by one task are one delivered draft", () => {
  const revisions = [capture(1), capture(2), capture(3), capture(4)];
  const registrations = [
    { revision_id: "r1", task_id: "a", task_status: "completed" },
    { revision_id: "r2", task_id: "b", task_status: "completed" },
    { revision_id: "r3", task_id: "b", task_status: "completed" },
  ];
  const result = groupDocumentDrafts({
    documentId: "doc",
    revisions,
    replacements: [],
    registrations,
    currentRevisionId: "r4",
  });
  expect(result.revisions.map((r) => r.version)).toEqual([1, 2, 2, 2]);
  expect(result.drafts).toHaveLength(2);
});
test("idempotent metadata backfill preserves immutable bytes, ids and review anchors", () => {
  const Database = require("better-sqlite3");
  const {
    initializeDocumentReviews,
    createDocumentReviewStore,
  } = require("../../db/document-reviews");
  const db = new Database(":memory:");
  initializeDocumentReviews(db);
  const store = createDocumentReviewStore(db);
  const doc = store.insertDocument({
    title: "Outline",
    path: "/tmp/outline.md",
  });
  const a = store.insertRevision({
    ...capture(1, 5),
    document_id: doc.id,
    byte_length: 100,
    line_count: 3,
  });
  const b = store.insertRevision({
    ...capture(2, 5),
    document_id: doc.id,
    byte_length: 101,
    line_count: 3,
  });
  store.setCurrentRevision(doc.id, b.id);
  const review = store.insertReview({
    document_id: doc.id,
    revision_id: a.id,
    reviewer_id: "operator",
  });
  const comment = store.insertComment({
    review_id: review.id,
    kind: "passage",
    start_line: 1,
    end_line: 1,
    quote: "# Outline",
    body: "Keep this anchor",
    block_hash: "anchor-hash",
  });
  const before = db
    .prepare("SELECT * FROM review_document_revisions ORDER BY rowid")
    .all();
  const first = reconcileDocumentDrafts(db, doc.id);
  const again = reconcileDocumentDrafts(db, doc.id);
  expect(again).toEqual(first);
  expect(
    db.prepare("SELECT * FROM review_document_revisions ORDER BY rowid").all(),
  ).toEqual(before);
  expect(store.revisionVersion(b.id)).toBe(5);
  expect(store.revisionDraft(a.id).capture_number).toBe(1);
  expect(store.draftHistory(doc.id).drafts).toHaveLength(1);
  expect(store.getComment(comment.id)).toEqual(comment);
  expect(store.getReview(review.id).revision_id).toBe(a.id);
  expect(
    db.prepare("SELECT COUNT(*) n FROM review_document_draft_captures").get().n,
  ).toBe(2);
  db.close();
});
test("later explicit label updates replacement grouping for subsequent unlabeled captures", () => {
  const revisions = [capture(1, 3), capture(2, 3), capture(3, 4), capture(4)];
  const result = groupDocumentDrafts({
    documentId: "doc",
    revisions,
    replacements: [
      {
        id: "work",
        base_revision_id: "r1",
        result_revision_id: "r4",
        state: "ready",
      },
    ],
    registrations: [],
    currentRevisionId: "r4",
  });
  expect(result.revisions.map((r) => r.version)).toEqual([3, 3, 4, 4]);
});
test("failed work without output cannot swallow recovery or later delivered draft groups", () => {
  const revisions = [capture(1), capture(2), capture(3)];
  const replacements = [
    {
      id: "failed",
      base_revision_id: "r1",
      result_revision_id: null,
      state: "failed",
    },
    {
      id: "recovery",
      base_revision_id: "r1",
      result_revision_id: "r2",
      state: "ready",
    },
    {
      id: "later",
      base_revision_id: "r2",
      result_revision_id: "r3",
      state: "ready",
    },
  ];
  const result = groupDocumentDrafts({
    documentId: "doc",
    revisions,
    replacements,
    registrations: [],
    currentRevisionId: "r3",
  });
  expect(result.revisions.map((r) => r.version)).toEqual([1, 2, 3]);
  expect(result.drafts).toHaveLength(3);
});
