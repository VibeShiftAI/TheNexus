const express = require("express");
const {
  migrateAgentReviewComments,
} = require("../services/document-unified-comments");
const fs = require("fs");
const {
  createPraxisProposalGenerator,
} = require("../services/document-praxis-proposals");
const {
  convertCommentToSuggestion,
} = require("../services/document-operator-suggestions");
const { randomUUID, timingSafeEqual } = require("crypto");
const { publicReview } = require("../../db/document-agent-reviews");
const {
  validateFindings,
  composeSuggestions,
  fail,
  short,
} = require("../services/document-agent-reviews");
const {
  requireStakeholderAuthority,
} = require("../services/stakeholder-authority");
const {
  listProjectRoots,
  resolveDocumentPath,
  readArtifactFile,
  sha256,
} = require("../services/document-registry");
const media = require("../services/review-media");
function createAgentReviewsRouter({
  db,
  authorizeDecision,
  recordRevision,
  reviewability,
  reconcileReplacement,
  proposalCompletion,
}) {
  const router = express.Router();
  const docs = db.documentReviews;
  const store = db.agentReviews;
  const generateProposal = createPraxisProposalGenerator({
    db,
    complete: proposalCompletion,
    reviewability,
    reconcileReplacement,
  });
  const wrap = (fn) => async (req, res) => {
    try {
      if (!store) fail("Review storage unavailable", "unavailable", 503);
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 500).json({
        error: e.message,
        code: e.code || "review_failed",
        ...(e.retry_with_new_request_id !== undefined
          ? { retry_with_new_request_id: e.retry_with_new_request_id }
          : {}),
        ...(e.existing_comment_id
          ? { existing_comment_id: e.existing_comment_id }
          : {}),
      });
    }
  };
  const document = (req) => {
    const d = docs.getDocument(req.params.id);
    if (!d) fail("Document not found", "not_found", 404);
    return d;
  };
  const review = (req) => {
    const r = store.get(req.params.reviewId);
    if (!r || r.document_id !== document(req).id)
      fail("Review not found", "not_found", 404);
    return r;
  };
  const exact = (r) => docs.getRevisionExact(r.id) ?? r.content;
  async function operator(req) {
    if (req.get("sec-fetch-site") === "cross-site")
      fail("Same-origin requests only", "cross_site", 403);
    const a = await authorizeDecision(req);
    if (!a.ok || a.actor.authority === "document_executor_credential")
      fail(a.error || "Operator required", "operator_required", 403);
    return a.actor;
  }
  function capability(req, r) {
    const t =
      req.get("x-document-review-token") ||
      (req.get("authorization") || "").replace(/^Bearer /, "");
    const a = Buffer.from(t);
    const b = Buffer.from(r.submission_token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async function runtimeOrOperator(req) {
    try {
      requireStakeholderAuthority(req, "runtime");
      return { id: req.user.id, authority: "runtime" };
    } catch {
      return operator(req);
    }
  }
  router.post(
    "/reviews/:reviewId/comments/:commentId/proposal",
    wrap(async (req, res) => {
      const actor = await operator(req);
      if (Object.keys(req.body || {}).some((k) => k !== "client_request_id"))
        fail("Generation accepts only client_request_id");
      const result = await generateProposal({
        reviewId: req.params.reviewId,
        commentId: req.params.commentId,
        clientRequestId: req.body?.client_request_id,
        actor,
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    }),
  );
  router.post(
    "/reviews/:reviewId/comments/:commentId/suggestion",
    wrap(async (req, res) => {
      const actor = await operator(req);
      const result = await convertCommentToSuggestion({
        db,
        reviewId: req.params.reviewId,
        commentId: req.params.commentId,
        body: req.body || {},
        actor,
        reviewability,
        reconcileReplacement,
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    }),
  );
  router.post(
    "/:id/agent-reviews",
    wrap(async (req, res) => {
      const actor = await runtimeOrOperator(req);
      const d = document(req);
      const b = req.body || {};
      if (
        !short(b.task_id) ||
        !short(b.base_revision_id) ||
        !short(b.client_request_id) ||
        (b.instructions !== undefined &&
          (typeof b.instructions !== "string" || b.instructions.length > 20000))
      )
        fail("task_id, base_revision_id and client_request_id required");
      const task = await db.getTask(b.task_id);
      if (!task || !d.project_id || task.project_id !== d.project_id)
        fail(
          "Task and document must belong to the same project",
          "binding_mismatch",
          409,
        );
      const revision = docs.getRevision(b.base_revision_id);
      if (!revision || revision.document_id !== d.id)
        fail("Assigned revision not found", "binding_mismatch", 409);
      const r = store.assign({
        document_id: d.id,
        task_id: task.id,
        base_revision_id: revision.id,
        base_content_hash: sha256(Buffer.from(exact(revision) || "")),
        client_request_id: b.client_request_id,
        instructions: b.instructions || "",
        author: store.assignmentAuthor(task.id, {
          id: task.assigned_to || task.id,
          authority: "assigned_executor",
          task_id: task.id,
        }),
        assigned_by: actor,
      });
      res.status(201).json({
        review: publicReview(r),
        submission_token: r.submission_token,
      });
    }),
  );
  router.get(
    "/:id/agent-reviews",
    wrap(async (req, res) => {
      document(req);
      res.json({ reviews: store.list(req.params.id) });
    }),
  );
  router.get(
    "/:id/agent-reviews/:reviewId",
    wrap(async (req, res) => {
      const r = review(req);
      if (!capability(req, r)) {
        if (req.get("x-document-review-token"))
          fail(
            "Assigned review capability is invalid",
            "capability_required",
            403,
          );
        await runtimeOrOperator(req);
      }
      const revision = docs.getRevision(r.base_revision_id);
      res.json({
        review: publicReview(r),
        revision: {
          ...revision,
          ...docs.revisionDraft?.(revision.id),
          content: exact(revision),
        },
        read_receipt: store.recordRead(
          r.id,
          capability(req, r) ? `executor:${r.task_id}` : req.user.id,
          revision.id,
        ),
        current_revision_id: document(req).current_revision_id,
      });
    }),
  );
  router.post(
    "/:id/agent-reviews/:reviewId/submit",
    wrap(async (req, res) => {
      const r = review(req);
      if (!capability(req, r))
        fail("Assigned review capability required", "capability_required", 403);
      const rev = docs.getRevision(r.base_revision_id);
      const findings = validateFindings(
        req.body || {},
        exact(rev) || "",
        rev.media_type || "markdown",
      );
      const fingerprint = sha256(Buffer.from(JSON.stringify(findings)));
      const result = store.transaction(() => {
        const fresh = review(req);
        if (fresh.client_submission_id) {
          if (
            fresh.client_submission_id !== findings.client_submission_id ||
            fresh.submission_hash !== fingerprint
          )
            fail(
              "Submission already sealed with different findings",
              "idempotency_conflict",
              409,
            );
          migrateAgentReviewComments(db, { reviewId: fresh.id });
          return store.get(fresh.id);
        }
        const submitted_at = new Date().toISOString();
        store.save({
          ...fresh,
          ...findings,
          comments: findings.comments.map((c) => ({
            ...c,
            author: fresh.author,
            replies: [],
            resolved: false,
          })),
          choices: findings.suggestions.map((s) => ({
            suggestion_id: s.id,
            status: "pending",
          })),
          status: "submitted",
          submission_hash: fingerprint,
          submitted_at,
          receipt: {
            id: randomUUID(),
            review_id: r.id,
            task_id: r.task_id,
            base_revision_id: r.base_revision_id,
            submitted_at,
          },
        });
        migrateAgentReviewComments(db, { reviewId: fresh.id });
        return store.get(fresh.id);
      });
      res.json({
        review: publicReview(store.get(result.id)),
        receipt: result.receipt,
      });
    }),
  );
  router.patch(
    "/:id/agent-reviews/:reviewId/choices",
    wrap(async (req, res) => {
      const actor = await operator(req);
      const choices = req.body?.choices;
      if (!Array.isArray(choices) || choices.length > 500)
        fail("choices array required");
      const r = store.transaction(() => {
        const r = review(req);
        if (r.status !== "submitted" || r.application)
          fail(
            "This review is historical or application has started",
            "review_closed",
            409,
          );
        const next = [...r.choices];
        const seen = new Set();
        for (const c of choices) {
          if (!c || typeof c !== "object" || Array.isArray(c))
            fail("Invalid suggestion choice");
          if (
            !r.suggestions.some((s) => s.id === c.suggestion_id) ||
            seen.has(c.suggestion_id) ||
            !["accepted", "rejected", "pending"].includes(c.status) ||
            (c.replacement !== undefined &&
              (typeof c.replacement !== "string" ||
                c.replacement.length > 1000000))
          )
            fail("Invalid suggestion choice");
          seen.add(c.suggestion_id);
          next[next.findIndex((x) => x.suggestion_id === c.suggestion_id)] = {
            suggestion_id: c.suggestion_id,
            status: c.status,
            ...(c.replacement !== undefined
              ? { replacement: c.replacement }
              : {}),
            actor,
            updated_at: new Date().toISOString(),
          };
        }
        return store.save({ ...r, choices: next });
      });
      res.json({ review: publicReview(r) });
    }),
  );
  router.post(
    "/:id/agent-reviews/:reviewId/comments",
    wrap(async (req, res) => {
      const actor = await operator(req);
      const b = req.body || {};
      if (
        b.body !== undefined &&
        (typeof b.body !== "string" || !b.body.trim() || b.body.length > 20000)
      )
        fail("Invalid reply");
      if (b.resolved !== undefined && typeof b.resolved !== "boolean")
        fail("Invalid resolved state");
      const r = store.transaction(() => {
        const r = review(req);
        migrateAgentReviewComments(db, { reviewId: r.id });
        const root = docs
          .listComments(r.id)
          .find(
            (c) =>
              !c.parent_id &&
              (c.provenance?.finding_id === b.comment_id ||
                c.id === b.comment_id),
          );
        if (!root) fail("Comment not found", "not_found", 404);
        if (b.client_id !== undefined && !short(b.client_id))
          fail("Invalid client_id");
        if (b.body) {
          const prior =
            b.client_id && docs.findCommentByClientId(r.id, b.client_id);
          if (prior && (prior.body !== b.body || prior.parent_id !== root.id))
            fail("Reply retry differs", "idempotency_conflict", 409);
          if (!prior)
            docs.insertComment({
              review_id: r.id,
              client_id: b.client_id || null,
              kind: "document",
              body: b.body,
              parent_id: root.id,
              author: actor,
              provenance: {
                agent_review_id: r.id,
                task_id: r.task_id,
                parent_finding_id: root.provenance.finding_id,
              },
            });
        }
        if (b.resolved !== undefined)
          docs.updateComment(root.id, {
            resolved_at: b.resolved ? new Date().toISOString() : null,
          });
        return store.get(r.id);
      });
      res.json({ review: publicReview(r) });
    }),
  );
  router.post(
    "/:id/agent-reviews/:reviewId/apply",
    wrap(async (req, res) => {
      const actor = await operator(req);
      if (!short(req.body?.client_apply_id)) fail("client_apply_id required");
      let r = review(req);
      const d = document(req);
      const base = docs.getRevision(r.base_revision_id);
      if (
        r.application &&
        r.application.client_apply_id !== req.body.client_apply_id
      )
        fail(
          "Use original application ID to recover this application",
          "idempotency_conflict",
          409,
        );
      if (r.application?.result_revision_id)
        return res.json({
          review: publicReview(r),
          revision: docs.getRevision(r.application.result_revision_id),
          duplicate: true,
          no_changes: r.application.no_changes === true,
        });
      if (r.status !== "submitted")
        fail("Review is not submitted", "review_closed", 409);
      if (!r.choices.some((c) => c.status === "accepted")) {
        if (r.choices.some((c) => c.status === "pending"))
          fail(
            "Decide remaining suggestions before finishing",
            "pending_suggestions",
            409,
          );
        const finished = store.transaction(() => {
          const fresh = review(req);
          if (fresh.status !== "submitted")
            fail("Review already closed", "review_closed", 409);
          return store.save({
            ...fresh,
            status: "applied",
            result_revision_id: base.id,
            application: {
              client_apply_id: req.body.client_apply_id,
              result_revision_id: base.id,
              no_changes: true,
              actor,
              applied_at: new Date().toISOString(),
            },
          });
        });
        return res.json({
          review: publicReview(finished),
          revision: base,
          no_changes: true,
        });
      }
      const content =
        r.application?.content ??
        composeSuggestions(exact(base), r.suggestions, r.choices);
      const bytes = Buffer.from(content);
      const targetHash = sha256(bytes);
      if (bytes.length > media.maxBytesFor(base.media_type || "markdown"))
        fail("Result exceeds document size limit", "too_large", 413);
      const roots = await listProjectRoots(db);
      const resolved = resolveDocumentPath(d.path, roots);
      if (!resolved.ok || resolved.canonicalPath !== d.path)
        fail("Source path is unavailable or changed", "path_changed", 409);
      await reconcileReplacement(d);
      const gate = reviewability(d, base);
      if (!gate.ok && gate.reason !== "revision_not_ready")
        fail(
          "Document has active or failed replacement work",
          gate.reason,
          409,
        );
      // No asynchronous work after this point: SQLite's write lock serializes all local applications.
      r = store.transaction(() => {
        let fresh = review(req);
        if (
          fresh.application &&
          fresh.application.client_apply_id !== req.body.client_apply_id
        )
          fail(
            "Another application already owns this review; retry its original ID",
            "idempotency_conflict",
            409,
          );
        if (JSON.stringify(fresh.choices) !== JSON.stringify(r.choices))
          fail(
            "Choices changed while applying; retry with the saved choices",
            "choices_changed",
            409,
          );
        const current = docs.getDocument(d.id);
        const diskBytes = fs.readFileSync(d.path);
        const diskHash = sha256(diskBytes);
        if (
          !docs.getRevisionExact(base.id) &&
          diskHash !== fresh.base_content_hash &&
          diskBytes
            .toString("utf8")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n") === base.content
        )
          fail(
            "Legacy revision has no exact-byte snapshot; request a review of a newly captured revision",
            "snapshot_unavailable",
            409,
          );
        const recovering = !!fresh.application && diskHash === targetHash;
        if (
          current.current_revision_id !== base.id &&
          !(
            recovering &&
            docs.getRevision(current.current_revision_id)?.content_hash ===
              targetHash
          )
        )
          fail(
            "Document changed; request a fresh review. Your choices are retained.",
            "stale_revision",
            409,
          );
        if (!recovering && diskHash !== fresh.base_content_hash)
          fail(
            "Source changed; request a fresh review. Your choices are retained.",
            "stale_revision",
            409,
          );
        if (!fresh.application)
          fresh = store.save({
            ...fresh,
            application: {
              client_apply_id: req.body.client_apply_id,
              content,
              target_hash: targetHash,
              actor,
              started_at: new Date().toISOString(),
            },
          });
        return fresh;
      });
      // The durable intent above survives a crash between the atomic rename and registration.
      r = store.transaction(() => {
        const fresh = review(req);
        if (fresh.application.result_revision_id) return fresh;
        const disk = sha256(fs.readFileSync(d.path));
        if (disk !== targetHash && disk !== fresh.base_content_hash)
          fail("Source changed during application", "stale_revision", 409);
        const current = docs.getDocument(d.id);
        if (
          current.current_revision_id !== base.id &&
          docs.getRevision(current.current_revision_id)?.content_hash !==
            targetHash
        )
          fail(
            "Registered revision changed during application",
            "stale_revision",
            409,
          );
        if (disk !== targetHash) {
          const tmp = `${d.path}.nexus-edit-${randomUUID()}.tmp`;
          try {
            fs.writeFileSync(tmp, bytes, { mode: fs.statSync(d.path).mode });
            fs.renameSync(tmp, d.path);
          } finally {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          }
        }
        const read = readArtifactFile(d.path, {
          mediaType: base.media_type || "markdown",
          root: resolved.root.root,
        });
        if (!read.ok) fail(read.error, read.code, read.status);
        const { revision } = recordRevision(
          d,
          read,
          fs.statSync(d.path).mtime.toISOString(),
          { source: "nexus_edit", editedBy: actor.id },
        );
        docs.setCurrentRevision(d.id, revision.id);
        const application = {
          ...fresh.application,
          result_revision_id: revision.id,
          applied_at: new Date().toISOString(),
        };
        return store.save({
          ...fresh,
          status: "applied",
          result_revision_id: revision.id,
          application,
        });
      });
      res.json({
        review: publicReview(r),
        revision: docs.getRevision(r.result_revision_id),
      });
    }),
  );
  router.get(
    "/:id/submissions/:submissionId/package",
    wrap(async (req, res) => {
      await runtimeOrOperator(req);
      const d = document(req);
      const s = docs.getSubmission(req.params.submissionId);
      if (!s || s.document_id !== d.id)
        fail("Submission not found", "not_found", 404);
      const rev = docs.getRevision(s.revision_id);
      res.json({
        submission_id: s.id,
        read_receipt: store.recordRead(s.id, req.user.id, rev.id),
        document_id: d.id,
        revision_id: rev.id,
        document: d,
        revision: {
          ...rev,
          ...docs.revisionDraft?.(rev.id),
          content: exact(rev),
        },
        feedback: s.payload,
        decisions:
          s.payload.decisions ||
          docs
            .listDecisions(d.id)
            .filter(
              (decision) =>
                decision.revision_id === rev.id &&
                decision.created_at <= (s.payload.submitted_at || s.created_at),
            ),
        current_revision_id: d.current_revision_id,
        review: docs.getReview(s.review_id),
        delivery_status: s.delivery_status,
      });
    }),
  );
  return router;
}
module.exports = { createAgentReviewsRouter };
