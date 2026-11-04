/** Operator-authored edits derived from feedback, separate from the executor's sealed findings. */
const fs = require("fs");
const { randomUUID } = require("crypto");
const {
  listProjectRoots,
  resolveDocumentPath,
  sha256,
} = require("./document-registry");
const { validateFindings, fail, short } = require("./document-agent-reviews");
const { inlineComments, passage } = require("./document-unified-comments");
async function convertCommentToSuggestion({
  db,
  reviewId,
  commentId,
  body,
  actor,
  reviewability,
  reconcileReplacement,
  proposalAuthor,
  proposalProvenance,
  proposalExplanation,
}) {
  const docs = db.documentReviews,
    agents = db.agentReviews;
  const review = agents.get(reviewId),
    source = docs.getComment(commentId);
  if (
    !review?.unified_review_id ||
    !source ||
    source.review_id !== review.unified_review_id
  )
    fail("Comment not found on this review", "not_found", 404);
  if (source.parent_id || source.suggestion)
    fail(
      "Choose an original comment without a replacement",
      "invalid_source",
      400,
    );
  const document = docs.getDocument(review.document_id),
    revision = docs.getRevision(review.base_revision_id);
  if (!document || !revision)
    fail("Reviewed snapshot unavailable", "snapshot_unavailable", 409);
  if (
    !short(body.client_request_id) ||
    typeof body.proposed !== "string" ||
    body.proposed.length > 1000000 ||
    !["accepted", "pending"].includes(body.status)
  )
    fail(
      "client_request_id, proposed text and accepted or pending status required",
    );
  if (
    body.base_revision_id !== undefined &&
    body.base_revision_id !== revision.id
  )
    fail("Editor revision differs from this comment", "stale_revision", 409);
  const stored = source.provenance || {};
  const supplied = ["start", "end", "original"].some(
    (k) => body[k] !== undefined,
  );
  let range;
  if (stored.start !== undefined) {
    range = { start: stored.start, end: stored.end, original: stored.original };
    if (
      supplied &&
      ["start", "end", "original"].some((k) => body[k] !== range[k])
    )
      fail("Use this comment’s exact passage range", "range_mismatch", 409);
  } else {
    if (!supplied)
      fail(
        "Select the exact passage for this document-wide comment",
        "range_required",
        400,
      );
    range = { start: body.start, end: body.end, original: body.original };
  }
  const exact = docs.getRevisionExact(revision.id) ?? revision.content;
  const proposal = {
    id: "validation",
    ...range,
    proposed: body.proposed,
    explanation: source.body,
  };
  validateFindings(
    {
      client_submission_id: "operator-proposal",
      summary: "Operator proposed edit",
      comments: [],
      suggestions: [proposal],
    },
    exact,
    revision.media_type || "markdown",
  );
  const fingerprint = sha256(
    JSON.stringify({
      comment_id: source.id,
      ...range,
      proposed: body.proposed,
      status: body.status,
    }),
  );
  const clientId = `operator-suggestion:${body.client_request_id}`;
  const prior = () => docs.findCommentByClientId(review.id, clientId);
  const response = (comment, duplicate) => ({
    comment: inlineComments(
      db,
      document.id,
      docs.getRevision(document.current_revision_id),
    ).find((c) => c.id === comment.id),
    review: require("../../db/document-agent-reviews").publicReview(
      agents.get(review.id),
    ),
    duplicate,
  });
  const checkPrior = (existing) => {
    if (existing.provenance?.request_hash !== fingerprint)
      fail(
        "This request ID was already used for a different proposed edit",
        "idempotency_conflict",
        409,
      );
    return response(existing, true);
  };
  const sourceProposal = () =>
    docs
      .listComments(review.id)
      .find(
        (c) =>
          c.provenance?.kind === "operator_suggestion" &&
          c.provenance.source_comment_id === source.id,
      );
  const checkSource = (existing) => {
    if (existing.provenance?.request_hash !== fingerprint)
      throw Object.assign(
        new Error(
          `This comment already has a suggested edit; edit its saved choice instead of creating another proposal`,
        ),
        {
          status: 409,
          code: "already_converted",
          existing_comment_id: existing.id,
        },
      );
    return response(existing, true);
  };
  if (prior()) return checkPrior(prior());
  if (sourceProposal()) return checkSource(sourceProposal());
  const roots = await listProjectRoots(db),
    resolved = resolveDocumentPath(document.path, roots);
  if (!resolved.ok || resolved.canonicalPath !== document.path)
    fail("Source path is unavailable or changed", "path_changed", 409);
  await reconcileReplacement(document);
  return docs.transaction(() => {
    if (prior()) return checkPrior(prior());
    if (sourceProposal()) return checkSource(sourceProposal());
    const fresh = agents.get(review.id),
      current = docs.getDocument(document.id);
    if (fresh.status !== "submitted" || fresh.application)
      fail(
        "This review has already been applied; request a fresh review",
        "review_closed",
        409,
      );
    if (
      current.current_revision_id !== revision.id ||
      sha256(fs.readFileSync(document.path)) !== fresh.base_content_hash
    )
      fail(
        "Source changed; keep your proposed text and select a current review",
        "stale_revision",
        409,
      );
    const gate = reviewability(current, revision);
    if (!gate.ok)
      fail("Document is not available for review", gate.reason, 409);
    if (fresh.suggestions.length >= 500)
      fail(
        "This review has reached the suggestion limit",
        "too_many_suggestions",
        409,
      );
    const id = randomUUID(),
      author = proposalAuthor || { ...actor, name: actor.name || "You" };
    const suggestion = {
      id,
      ...range,
      proposed: body.proposed,
      explanation: proposalExplanation || source.body,
    };
    const comment = docs.insertComment({
      id,
      review_id: review.id,
      client_id: clientId,
      body: proposalAuthor ? "Praxis proposed edit" : "Operator proposed edit",
      ...passage(suggestion, exact, revision.content),
      author,
      suggestion,
      provenance: {
        agent_review_id: review.id,
        task_id: review.task_id,
        finding_id: id,
        kind: "operator_suggestion",
        origin: proposalAuthor ? "praxis" : "operator",
        ...(proposalProvenance || {}),
        source_comment_id: source.id,
        client_request_id: body.client_request_id,
        request_hash: fingerprint,
        ...range,
      },
    });
    agents.save({
      ...fresh,
      choices: [
        ...fresh.choices,
        {
          suggestion_id: id,
          status: body.status,
          actor: author,
          updated_at: new Date().toISOString(),
        },
      ],
    });
    return response(comment, false);
  });
}
module.exports = { convertCommentToSuggestion };
