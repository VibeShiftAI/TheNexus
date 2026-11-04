/** Editorial draft labels are a projection over immutable byte captures, never their identity. */
function primaryDraftNumber(content) {
  if (typeof content !== "string") return null;
  const opening = content.slice(0, 1600).split(/\r?\n/).slice(0, 8);
  for (const raw of opening) {
    const line = raw.trim().replace(/^[*_]+|[*_]+$/g, "");
    // Deliberate version metadata only. Never search prose or filenames for an arbitrary vN.
    const match =
      line.match(/^(?:draft|version)\s*[:#]?\s*v?(\d+)\b/i) ||
      line.match(/^[^\n]*?[·|—–]\s*v(\d+)\b/i);
    if (match && Number(match[1]) > 0 && Number(match[1]) <= 10000)
      return Number(match[1]);
  }
  return null;
}
function groupDocumentDrafts({
  documentId,
  revisions,
  replacements = [],
  registrations = [],
  currentRevisionId,
}) {
  const indices = new Map(revisions.map((r, i) => [r.id, i]));
  const versions = revisions.map((r) => primaryDraftNumber(r.content));
  const delivered = new Set(revisions.length ? [revisions[0].id] : []);
  const deliveryOwner = new Map();
  const resultWork = new Map();
  for (const work of replacements) {
    if (indices.has(work.result_revision_id))
      resultWork.set(work.result_revision_id, work);
    if (work.state === "ready" && indices.has(work.result_revision_id))
      delivered.add(work.result_revision_id);
  }
  // A task's repeated handoffs are one delivery. Completed replacement identity wins over task aliases.
  for (const registration of registrations) {
    if (!indices.has(registration.revision_id)) continue;
    const work =
      resultWork.get(registration.revision_id) ||
      replacements.find((w) => w.task_id && w.task_id === registration.task_id);
    const owner = work
      ? `replacement:${work.id}`
      : `task:${registration.task_id}`;
    deliveryOwner.set(registration.revision_id, owner);
    if (
      work
        ? work.state === "ready"
        : ["completed", "complete", "done"].includes(registration.task_status)
    )
      delivered.add(registration.revision_id);
  }
  // Assign fallback draft groups to each replacement interval, including its in-progress captures.
  const intervals = replacements
    .filter(
      (w) =>
        indices.has(w.base_revision_id) &&
        (indices.has(w.result_revision_id) ||
          !["failed", "cancelled"].includes(w.state)),
    )
    .map((w) => ({
      ...w,
      start: indices.get(w.base_revision_id) + 1,
      end: indices.has(w.result_revision_id)
        ? indices.get(w.result_revision_id)
        : revisions.length - 1,
    }))
    .sort((a, b) => a.start - b.start);
  const ownerVersion = new Map();
  let last = 1;
  for (let i = 0; i < revisions.length; i++) {
    const r = revisions[i];
    const interval = intervals.findLast((w) => i >= w.start && i <= w.end);
    const owner = interval
      ? `replacement:${interval.id}`
      : deliveryOwner.get(r.id);
    if (versions[i] === null) {
      if (owner && ownerVersion.has(owner))
        versions[i] = ownerVersion.get(owner);
      else if (interval)
        versions[i] =
          (versions[indices.get(interval.base_revision_id)] ?? last) + 1;
      else if (owner && i > 0 && delivered.has(r.id)) versions[i] = last + 1;
      else versions[i] = last;
    }
    if (owner) ownerVersion.set(owner, versions[i]);
    last = versions[i];
  }
  const rows = revisions.map((r, i) => {
    const { content, ...meta } = r;
    return {
      ...meta,
      version: versions[i],
      draft_id: `${documentId}:draft:${versions[i]}`,
      capture_number: i + 1,
      is_delivered: delivered.has(r.id),
      is_current: r.id === currentRevisionId,
    };
  });
  const groups = new Map();
  for (const row of rows) {
    let group = groups.get(row.draft_id);
    if (!group) {
      group = { captures: [], delivered: [] };
      groups.set(row.draft_id, group);
    }
    group.captures.push(row);
    if (row.is_delivered) group.delivered.push(row);
  }
  const drafts = [];
  for (const group of groups.values()) {
    if (!group.delivered.length) continue;
    let representative = group.delivered.at(-1);
    const current = group.captures.find((r) => r.is_current);
    const currentInOpenWork =
      current &&
      intervals.some(
        (w) =>
          w.state !== "ready" &&
          indices.get(current.id) >= w.start &&
          indices.get(current.id) <= w.end,
      );
    // Edits to the current delivered draft replace its selector target without inventing a new version.
    if (current && !currentInOpenWork) representative = current;
    drafts.push({ ...representative, capture_count: group.captures.length });
  }
  drafts.sort((a, b) => a.version - b.version);
  return { revisions: rows, drafts };
}
function initializeDocumentDrafts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS review_document_draft_captures (
    revision_id TEXT PRIMARY KEY REFERENCES review_document_revisions(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL, draft_id TEXT NOT NULL, draft_number INTEGER NOT NULL,
    capture_number INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX IF NOT EXISTS idx_document_draft_captures ON review_document_draft_captures(document_id,draft_number);`);
}
/** Idempotent, document-scoped metadata backfill. Immutable rows/content/anchors are never edited. */
function reconcileDocumentDrafts(db, documentId) {
  initializeDocumentDrafts(db);
  const document = db
    .prepare("SELECT current_revision_id FROM review_documents WHERE id=?")
    .get(documentId);
  const revisions = db
    .prepare(
      "SELECT id,document_id,content_hash,byte_length,line_count,file_mtime,captured_at,media_type,mime_type,source,edited_by,asset_count,width,height,substr(content,1,1600) AS content FROM review_document_revisions WHERE document_id=? ORDER BY captured_at,rowid",
    )
    .all(documentId);
  const replacements = db
    .prepare(
      "SELECT * FROM review_document_replacements WHERE document_id=? ORDER BY created_at,rowid",
    )
    .all(documentId);
  const hasTasks = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
    )
    .get();
  const registrations = db
    .prepare(
      hasTasks
        ? "SELECT r.*, t.status AS task_status FROM review_document_registrations r LEFT JOIN tasks t ON t.id=r.task_id WHERE r.document_id=? ORDER BY r.created_at,r.rowid"
        : "SELECT * FROM review_document_registrations WHERE document_id=? ORDER BY created_at,rowid",
    )
    .all(documentId);
  const result = groupDocumentDrafts({
    documentId,
    revisions,
    replacements,
    registrations,
    currentRevisionId: document?.current_revision_id,
  });
  const put =
    db.prepare(`INSERT INTO review_document_draft_captures VALUES (?,?,?,?,?,?)
    ON CONFLICT(revision_id) DO UPDATE SET draft_id=excluded.draft_id,draft_number=excluded.draft_number,capture_number=excluded.capture_number,delivered=excluded.delivered
    WHERE draft_id<>excluded.draft_id OR draft_number<>excluded.draft_number OR capture_number<>excluded.capture_number OR delivered<>excluded.delivered`);
  db.transaction(() => {
    for (const row of result.revisions)
      put.run(
        row.id,
        documentId,
        row.draft_id,
        row.version,
        row.capture_number,
        row.is_delivered ? 1 : 0,
      );
  })();
  return result;
}
module.exports = {
  primaryDraftNumber,
  groupDocumentDrafts,
  initializeDocumentDrafts,
  reconcileDocumentDrafts,
};
