const { randomUUID, randomBytes } = require("crypto");
function publicReview(row) {
  if (!row) return null;
  const { submission_token, ...review } = row;
  if (review.application) {
    const { content, ...application } = review.application;
    review.application = application;
  }
  return review;
}
function createAgentReviewStore(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS document_agent_reviews (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, client_request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(document_id,client_request_id));
     CREATE TABLE IF NOT EXISTS document_comment_proposal_jobs (review_id TEXT NOT NULL, source_comment_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(review_id,source_comment_id));
     CREATE TABLE IF NOT EXISTS document_review_read_receipts (reference_id TEXT NOT NULL, actor_id TEXT NOT NULL, revision_id TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY(reference_id, actor_id));`,
  );
  const read = (row) => (row ? JSON.parse(row.data) : null);
  const hydrate = (review) => {
    if (!review?.unified_review_id) return review;
    const rows = db
      .prepare(
        "SELECT * FROM document_review_comments WHERE review_id=? ORDER BY created_at,rowid",
      )
      .all(review.unified_review_id)
      .map((c) => ({
        ...c,
        author: c.author ? JSON.parse(c.author) : null,
        provenance: c.provenance ? JSON.parse(c.provenance) : {},
        suggestion: c.suggestion ? JSON.parse(c.suggestion) : null,
      }));
    const replies = (id) =>
      rows
        .filter((c) => c.parent_id === id)
        .map((c) => ({
          id: c.id,
          client_id: c.client_id,
          body: c.body,
          author: c.author,
          created_at: c.created_at,
        }));
    const roots = rows.filter((c) => !c.parent_id);
    return {
      ...review,
      comments: roots
        .filter((c) => !c.suggestion)
        .map((c) => ({
          id: c.provenance.finding_id,
          comment_id: c.id,
          body: c.body,
          author: c.author,
          ...(c.provenance.start === undefined
            ? {}
            : {
                start: c.provenance.start,
                end: c.provenance.end,
                original: c.provenance.original,
              }),
          replies: replies(c.id),
          resolved: !!c.resolved_at,
        })),
      suggestions: roots
        .filter((c) => c.suggestion)
        .map((c) => ({
          ...c.suggestion,
          author: c.author,
          origin:
            c.provenance.origin ||
            (c.provenance.kind === "operator_suggestion"
              ? "operator"
              : "executor"),
          source_comment_id: c.provenance.source_comment_id || null,
          comment_id: c.id,
          replies: replies(c.id),
          resolved: !!c.resolved_at,
        })),
    };
  };
  const store = {
    getProposalJob(reviewId, commentId) {
      return read(
        db
          .prepare(
            "SELECT data FROM document_comment_proposal_jobs WHERE review_id=? AND source_comment_id=?",
          )
          .get(reviewId, commentId),
      );
    },
    saveProposalJob(job) {
      db.prepare(
        "INSERT INTO document_comment_proposal_jobs VALUES (?,?,?) ON CONFLICT(review_id,source_comment_id) DO UPDATE SET data=excluded.data",
      ).run(job.review_id, job.source_comment_id, JSON.stringify(job));
      return job;
    },
    assignmentAuthor(taskId, original, submittedAt) {
      const taskTable = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'",
        )
        .get();
      const task = taskTable
        ? db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId)
        : null;
      let dispatch = null;
      const columns = new Set(
        db
          .prepare("PRAGMA table_info(task_dispatches)")
          .all()
          .map((c) => c.name),
      );
      if (
        ["id", "task_id", "executor", "kind", "started_at"].every((c) =>
          columns.has(c),
        )
      ) {
        dispatch = db
          .prepare(
            "SELECT id,executor FROM task_dispatches WHERE task_id=? AND kind='dispatch' AND executor IS NOT NULL AND (? IS NULL OR started_at<=?) ORDER BY started_at DESC,rowid DESC LIMIT 1",
          )
          .get(taskId, submittedAt || null, submittedAt || null);
      }
      const executor = dispatch?.executor || task?.default_executor;
      if (!executor) return original;
      const names = {
        claude: "Claude",
        "claude-code": "Claude",
        codex: "Codex",
        antigravity: "Antigravity",
        gemini: "Gemini",
      };
      return {
        ...original,
        executor,
        name: names[executor] || executor,
        attribution_source: dispatch
          ? "task_dispatches"
          : "task.default_executor",
        ...(dispatch ? { dispatch_id: dispatch.id } : {}),
      };
    },
    transaction(fn) {
      return db.transaction(fn).immediate();
    },
    recordRead(referenceId, actorId, revisionId) {
      const receipt = {
        reference_id: referenceId,
        actor_id: actorId,
        revision_id: revisionId,
        read_at: new Date().toISOString(),
      };
      db.prepare(
        "INSERT INTO document_review_read_receipts VALUES (?,?,?,?) ON CONFLICT(reference_id,actor_id) DO UPDATE SET revision_id=excluded.revision_id,read_at=excluded.read_at",
      ).run(referenceId, actorId, revisionId, receipt.read_at);
      return receipt;
    },
    get(id) {
      return hydrate(
        read(
          db
            .prepare("SELECT data FROM document_agent_reviews WHERE id=?")
            .get(id),
        ),
      );
    },
    list(id) {
      return db
        .prepare(
          "SELECT data FROM document_agent_reviews WHERE document_id=? ORDER BY rowid",
        )
        .all(id)
        .map(read)
        .map(hydrate)
        .map(publicReview);
    },
    save(review) {
      db.prepare("UPDATE document_agent_reviews SET data=? WHERE id=?").run(
        JSON.stringify(
          review.unified_review_id
            ? { ...review, comments: undefined, suggestions: undefined }
            : review,
        ),
        review.id,
      );
      return review;
    },
    assign(input) {
      return store.transaction(() => {
        const prior = read(
          db
            .prepare(
              "SELECT data FROM document_agent_reviews WHERE document_id=? AND client_request_id=?",
            )
            .get(input.document_id, input.client_request_id),
        );
        if (prior) {
          if (
            prior.task_id !== input.task_id ||
            prior.base_revision_id !== input.base_revision_id
          )
            throw Object.assign(
              new Error("Assignment retry does not match original binding"),
              { status: 409, code: "idempotency_conflict" },
            );
          return prior;
        }
        const row = {
          ...input,
          id: randomUUID(),
          submission_token: randomBytes(32).toString("hex"),
          status: "assigned",
          comments: [],
          suggestions: [],
          choices: [],
          created_at: new Date().toISOString(),
        };
        db.prepare("INSERT INTO document_agent_reviews VALUES (?,?,?,?)").run(
          row.id,
          row.document_id,
          row.client_request_id,
          JSON.stringify(row),
        );
        return row;
      });
    },
  };
  return store;
}
module.exports = { createAgentReviewStore, publicReview };
