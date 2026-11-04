/** Executor findings share the existing immutable review comments and thread store. */
const { createHash } = require("crypto");
const fmt = require("./document-review-format");
function findingCommentId(reviewId, findingId) {
  const hex = createHash("sha256")
    .update(JSON.stringify([reviewId, findingId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function passage(finding, exact, normalized) {
  if (finding.start === undefined) return { kind: "document" };
  if (
    !Number.isInteger(finding.start) ||
    !Number.isInteger(finding.end) ||
    exact.slice(finding.start, finding.end) !== finding.original
  )
    throw Error(`Finding ${finding.id} does not match the immutable snapshot`);
  const normalizedPrefix = (value) =>
    value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const start = normalizedPrefix(exact.slice(0, finding.start)).split(
    "\n",
  ).length;
  const end = normalizedPrefix(
    exact.slice(0, Math.max(finding.start, finding.end - 1)),
  ).split("\n").length;
  const quote = normalized
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
  const anchor = fmt.verifyPassageAnchor(
    { start_line: start, end_line: end, quote },
    normalized,
  );
  if (!anchor.ok) throw Error(anchor.error);
  const { ok, ...fields } = anchor;
  return { kind: "passage", ...fields, selection: finding.original };
}
/** Explicit, idempotent entry point; startup never migrates live findings implicitly. */
function migrateAgentReviewComments(db, { reviewId, documentId } = {}) {
  const docs = db.documentReviews,
    agents = db.agentReviews;
  const reviews = reviewId
    ? [agents.get(reviewId)]
    : agents.list(documentId).map((r) => agents.get(r.id));
  return docs.transaction(() =>
    reviews.filter(Boolean).map((review) => {
      if (documentId && review.document_id !== documentId)
        throw Error("Review/document binding mismatch");
      if (!review.client_submission_id)
        return { review_id: review.id, skipped: true };
      if (review.unified_review_id)
        return {
          review_id: review.id,
          migrated: false,
          comments: docs.listComments(review.unified_review_id).length,
        };
      const revision = docs.getRevision(review.base_revision_id);
      if (!revision || revision.document_id !== review.document_id)
        throw Error("Assigned revision missing");
      const exact = docs.getRevisionExact(revision.id) ?? revision.content;
      if (!docs.getReview(review.id))
        docs.insertReview({
          id: review.id,
          document_id: review.document_id,
          revision_id: revision.id,
          reviewer_id: `executor:${review.task_id}`,
          status: "submitted",
          summary: review.summary || "",
          submitted_at: review.submitted_at,
        });
      const roots = [
        ...(review.comments || []).map((c) => ({
          finding: c,
          kind: "comment",
        })),
        ...(review.suggestions || []).map((s) => ({
          finding: s,
          kind: "suggestion",
        })),
      ];
      if (!roots.length && review.summary?.trim())
        roots.push({
          finding: { id: "assessment", body: review.summary },
          kind: "assessment",
        });
      for (const { finding, kind } of roots) {
        const id = findingCommentId(review.id, finding.id);
        if (docs.getComment(id)) continue;
        const provenance = {
          agent_review_id: review.id,
          task_id: review.task_id,
          finding_id: finding.id,
          kind,
          ...(finding.start !== undefined
            ? {
                start: finding.start,
                end: finding.end,
                original: finding.original,
              }
            : {}),
        };
        docs.insertComment({
          id,
          review_id: review.id,
          created_at: finding.created_at || review.submitted_at,
          updated_at:
            finding.updated_at || finding.created_at || review.submitted_at,
          client_id: `agent:${finding.id}`,
          body: kind === "suggestion" ? finding.explanation : finding.body,
          ...passage(finding, exact, revision.content),
          author: agents.assignmentAuthor(
            review.task_id,
            finding.author || review.author,
            review.submitted_at,
          ),
          provenance,
          suggestion: kind === "suggestion" ? finding : null,
          resolved_at: finding.resolved
            ? finding.resolved_at || review.submitted_at
            : null,
        });
        for (const reply of finding.replies || [])
          docs.insertComment({
            id: findingCommentId(review.id, `reply:${reply.id}`),
            review_id: review.id,
            created_at: reply.created_at || review.submitted_at,
            updated_at:
              reply.updated_at || reply.created_at || review.submitted_at,
            client_id: reply.client_id || `reply:${reply.id}`,
            kind: "document",
            body: reply.body,
            parent_id: id,
            author: reply.author || { id: "unknown", authority: "legacy" },
            provenance: {
              agent_review_id: review.id,
              task_id: review.task_id,
              parent_finding_id: finding.id,
            },
          });
      }
      agents.save({ ...review, unified_review_id: review.id });
      return {
        review_id: review.id,
        migrated: true,
        comments: docs.listComments(review.id).length,
        suggestions: review.suggestions.length,
      };
    }),
  );
}
function inlineComments(db, documentId, revision) {
  return db.documentReviews
    .listAgentComments(documentId)
    .map((comment) => {
      const review = db.agentReviews.get(comment.provenance.agent_review_id);
      if (!review) return null;
      const result = {
        ...fmt.publicComment(comment),
        agent_review_id: review.id,
        revision_id: review.base_revision_id,
        historical: review.base_revision_id !== revision.id,
        source_comment_id: comment.provenance?.source_comment_id || null,
        anchor: fmt.anchorState(
          comment,
          revision.content,
          db.documentReviews.getRevisionMeta(review.base_revision_id)
            ?.content_hash,
          revision.content_hash,
        ),
      };
      if (comment.suggestion) {
        result.suggestion_id = comment.suggestion.id;
        result.choice = review.choices.find(
          (c) => c.suggestion_id === comment.suggestion.id,
        ) || { suggestion_id: comment.suggestion.id, status: "pending" };
      }
      return result;
    })
    .filter(Boolean);
}
module.exports = {
  migrateAgentReviewComments,
  findingCommentId,
  inlineComments,
  passage,
};
