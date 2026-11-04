const Database = require("better-sqlite3");
const { createAgentReviewStore } = require("../../db/document-agent-reviews");
const {
  validateFindings,
  composeSuggestions,
} = require("../services/document-agent-reviews");
test("durable assignment capability is private and stable across retries", () => {
  const db = new Database(":memory:");
  const store = createAgentReviewStore(db);
  const input = {
    document_id: "doc",
    client_request_id: "req",
    task_id: "task",
    base_revision_id: "rev",
  };
  const a = store.assign(input);
  const b = store.assign(input);
  expect(a.id).toBe(b.id);
  expect(a.submission_token).toBe(b.submission_token);
  expect(store.list("doc")[0].submission_token).toBeUndefined();
  db.close();
});
test("exact UTF16 ranges, insertions, decisions and overlaps", () => {
  const base = "A😀 BC";
  const findings = validateFindings(
    {
      client_submission_id: "one",
      summary: "review",
      comments: [{ id: "c", body: "Note" }],
      suggestions: [
        {
          id: "s",
          start: 4,
          end: 6,
          original: "BC",
          proposed: "DE",
          explanation: "Reason",
        },
      ],
    },
    base,
    "markdown",
  );
  expect(
    composeSuggestions(base, findings.suggestions, [
      { suggestion_id: "s", status: "accepted", replacement: "" },
    ]),
  ).toBe("A😀 ");
  expect(() =>
    validateFindings(
      {
        ...findings,
        suggestions: [
          {
            id: "x",
            start: 4,
            end: 6,
            original: "WRONG",
            proposed: "x",
            explanation: "e",
          },
        ],
      },
      base,
      "markdown",
    ),
  ).toThrow();
  expect(() =>
    composeSuggestions(
      base,
      [
        ...findings.suggestions,
        { id: "b", start: 5, end: 6, original: "C", proposed: "x" },
      ],
      [
        { suggestion_id: "s", status: "accepted" },
        { suggestion_id: "b", status: "accepted" },
      ],
    ),
  ).toThrow(/overlap/i);
});

describe("HTTP workflow with isolated database and source", () => {
  const fs = require("fs"),
    os = require("os"),
    path = require("path"),
    http = require("http"),
    express = require("express");
  let db, server, url, root, file;
  const proposalCompletion = jest.fn();
  const headers = { "content-type": "application/json" };
  const api = async (method, p, body, token = "operator") => {
    const response = await fetch(url + p, {
      method,
      headers: {
        ...headers,
        "x-test-actor": token,
        ...(token !== "operator" ? { "x-document-review-token": token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  beforeAll(async () => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-test-")),
    );
    process.env.NEXUS_DB_PATH = path.join(root, "db.sqlite");
    jest.resetModules();
    db = require("../../db");
    await db.upsertProject({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Review fixture",
      path: root,
    });
    await db.createTask({
      id: "task",
      project_id: "11111111-1111-4111-8111-111111111111",
      name: "Review",
      status: "in_progress",
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: "fixture" };
      next();
    });
    app.use(
      require("../routes/documents")({
        db,
        authorizeDecision: async (req) =>
          req.get("x-test-actor") === "operator"
            ? {
                ok: true,
                actor: { id: "operator", authority: "operator_credential" },
              }
            : { ok: false, error: "Operator required", status: 403 },
        delivery: { deliver: async () => null },
        proposalCompletion,
      }),
    );
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    delete process.env.NEXUS_DB_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function assignment(name = "a", content = "Alpha Beta Gamma") {
    file = path.join(root, `${name}.md`);
    fs.writeFileSync(file, content);
    const registered = await api("POST", "/", {
      path: file,
      title: name,
      project_id: "11111111-1111-4111-8111-111111111111",
      task_id: "task",
      deliverable: {
        purpose: "Review fixture",
        requires_review: true,
        intended_action: "none",
      },
    });
    if (registered.status !== 201) throw new Error(JSON.stringify(registered));
    const d = registered.body.document;
    const a = await api("POST", `/${d.id}/agent-reviews`, {
      task_id: "task",
      base_revision_id: d.current_revision_id,
      client_request_id: name,
    });
    expect(a.status).toBe(201);
    return { d, ...a.body };
  }
  async function submit(d, review, submission_token) {
    return api(
      "POST",
      `/${d.id}/agent-reviews/${review.id}/submit`,
      {
        client_submission_id: "submission",
        summary: "Improve wording",
        comments: [{ id: "comment", body: "Observation" }],
        suggestions: [
          {
            id: "s1",
            start: 0,
            end: 5,
            original: "Alpha",
            proposed: "First",
            explanation: "Clearer",
          },
          {
            id: "s2",
            start: 6,
            end: 10,
            original: "Beta",
            proposed: "Second",
            explanation: "Clearer",
          },
          {
            id: "s3",
            start: 11,
            end: 16,
            original: "Gamma",
            proposed: "Third",
            explanation: "Clearer",
          },
        ],
      },
      submission_token,
    );
  }
  test("submit retry, executor refusal, choices, reply and exact combined application", async () => {
    const { d, review, submission_token } = await assignment();
    const route = `/${d.id}/agent-reviews/${review.id}`;
    const one = await submit(d, review, submission_token);
    expect(one.status).toBe(200);
    expect((await submit(d, review, submission_token)).body.receipt.id).toBe(
      one.body.receipt.id,
    );
    expect(
      (
        await api(
          "PATCH",
          route + "/choices",
          { choices: [] },
          submission_token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api("PATCH", route + "/choices", {
          choices: [
            { suggestion_id: "s1", status: "accepted" },
            { suggestion_id: "s2", status: "rejected" },
            { suggestion_id: "s3", status: "accepted", replacement: "Final" },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("POST", route + "/comments", {
          comment_id: "comment",
          body: "Thanks",
          resolved: true,
        })
      ).body.review.comments[0].replies[0].author.id,
    ).toBe("operator");
    const result = await api("POST", route + "/apply", {
      client_apply_id: "apply",
    });
    expect(result.status).toBe(200);
    expect(fs.readFileSync(file, "utf8")).toBe("First Beta Final");
    expect(result.body.revision.content).toBe("First Beta Final");
    expect(
      (await api("POST", route + "/apply", { client_apply_id: "apply" })).body
        .revision.id,
    ).toBe(result.body.revision.id);
  });
  test("stale source retains saved choices and rejects mismatched assignment", async () => {
    const { d, review, submission_token } = await assignment("stale");
    await submit(d, review, submission_token);
    const route = `/${d.id}/agent-reviews/${review.id}`;
    await api("PATCH", route + "/choices", {
      choices: [
        { suggestion_id: "s1", status: "accepted", replacement: "Saved" },
      ],
    });
    fs.writeFileSync(file, "Changed externally");
    expect(
      (await api("POST", route + "/apply", { client_apply_id: "apply" })).body
        .code,
    ).toBe("stale_revision");
    expect((await api("GET", route)).body.review.choices[0].replacement).toBe(
      "Saved",
    );
    expect(
      (
        await api("POST", `/${d.id}/agent-reviews`, {
          task_id: "missing",
          base_revision_id: d.current_revision_id,
          client_request_id: "bad",
        })
      ).body.code,
    ).toBe("binding_mismatch");
  });
  test("recovery after source write and registration failure reuses intent", async () => {
    const { d, review, submission_token } = await assignment("recover");
    await submit(d, review, submission_token);
    const route = `/${d.id}/agent-reviews/${review.id}`;
    await api("PATCH", route + "/choices", {
      choices: [{ suggestion_id: "s1", status: "accepted" }],
    });
    const original = db.documentReviews.insertRevision;
    db.documentReviews.insertRevision = () => {
      throw new Error("Injected registration failure");
    };
    expect(
      (await api("POST", route + "/apply", { client_apply_id: "recover" }))
        .status,
    ).toBe(500);
    expect(fs.readFileSync(file, "utf8")).toBe("First Beta Gamma");
    db.documentReviews.insertRevision = original;
    const recovered = await api("POST", route + "/apply", {
      client_apply_id: "recover",
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body.revision.content).toBe("First Beta Gamma");
  });
  test("all rejected finishes without creating a revision", async () => {
    const { d, review, submission_token } = await assignment("reject");
    await submit(d, review, submission_token);
    const route = `/${d.id}/agent-reviews/${review.id}`;
    await api("PATCH", route + "/choices", {
      choices: ["s1", "s2", "s3"].map((suggestion_id) => ({
        suggestion_id,
        status: "rejected",
      })),
    });
    const result = await api("POST", route + "/apply", {
      client_apply_id: "finish",
    });
    expect(result.status).toBe(200);
    expect(result.body.no_changes).toBe(true);
    expect(result.body.revision.id).toBe(d.current_revision_id);
    expect(fs.readFileSync(file, "utf8")).toBe("Alpha Beta Gamma");
  });
  test("canonical package freezes decisions and includes exact snapshot and threaded feedback", async () => {
    const { d } = await assignment("package");
    const opened = await api("POST", `/${d.id}/reviews`, {
      revision_id: d.current_revision_id,
    });
    expect(opened.status).toBe(201);
    const rid = opened.body.review.id;
    const comment = await api("POST", `/reviews/${rid}/comments`, {
      body: "Please clarify the opening",
      kind: "document",
      client_id: "comment",
    });
    expect(comment.status).toBe(201);
    const decision = await api("POST", `/${d.id}/decisions`, {
      revision_id: d.current_revision_id,
      decision: "request_changes",
      note: "Clarify the opening",
    });
    expect(decision.status).toBe(201);
    const finished = await api("POST", `/reviews/${rid}/finish`, {
      summary: "Please make these changes",
    });
    expect(finished.status).toBe(202);
    const sid = finished.body.submission.id;
    const pkg = await api("GET", `/${d.id}/submissions/${sid}/package`);
    expect(pkg.status).toBe(200);
    expect(pkg.body.revision.content).toBe("Alpha Beta Gamma");
    expect(pkg.body.decisions[0].note).toBe("Clarify the opening");
    expect(JSON.stringify(pkg.body.feedback)).toContain(
      "Please clarify the opening",
    );
  });
  test("approved document enters suggestion queue without losing approval", async () => {
    const { d, review, submission_token } = await assignment("queue");
    await api("POST", `/${d.id}/decisions`, {
      revision_id: d.current_revision_id,
      decision: "approve",
    });
    await submit(d, review, submission_token);
    const listed = await api("GET", "/?status=needs_review");
    const item = listed.body.documents.find((x) => x.id === d.id);
    expect(item).toBeDefined();
    expect(item.review_status).toBe("approved");
    expect(item.agent_review_ready).toBe(true);
    expect(
      db.documentReviews.countDocumentsByStatus().needs_review,
    ).toBeGreaterThan(0);
  });
  test("simultaneous distinct apply IDs cannot adopt each others receipts", async () => {
    const { d, review, submission_token } = await assignment("race");
    await submit(d, review, submission_token);
    const route = `/${d.id}/agent-reviews/${review.id}`;
    await api("PATCH", route + "/choices", {
      choices: [{ suggestion_id: "s1", status: "accepted" }],
    });
    const results = await Promise.all(
      ["one", "two"].map((client_apply_id) =>
        api("POST", route + "/apply", { client_apply_id }),
      ),
    );
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(results.find((x) => x.status === 409).body.code).toBe(
      "idempotency_conflict",
    );
  });
  test("new reference CRLF snapshots retain exact bytes for suggestions", async () => {
    const source = "Alpha\r\nBeta";
    const pathname = path.join(root, "reference-crlf.md");
    fs.writeFileSync(pathname, source);
    const registered = await api("POST", "/", {
      path: pathname,
      title: "CRLF reference",
      project_id: "11111111-1111-4111-8111-111111111111",
      task_id: "task",
    });
    expect(registered.status).toBe(201);
    const d = registered.body.document;
    expect(db.documentReviews.getRevisionExact(d.current_revision_id)).toBe(
      source,
    );
    const assigned = await api("POST", `/${d.id}/agent-reviews`, {
      task_id: "task",
      base_revision_id: d.current_revision_id,
      client_request_id: "crlf",
    });
    const { review, submission_token } = assigned.body;
    const route = `/${d.id}/agent-reviews/${review.id}`;
    expect(
      (
        await api(
          "POST",
          route + "/submit",
          {
            client_submission_id: "s",
            summary: "Fix",
            comments: [],
            suggestions: [
              {
                id: "fix",
                start: 7,
                end: 11,
                original: "Beta",
                proposed: "Final",
                explanation: "Clearer",
              },
            ],
          },
          submission_token,
        )
      ).status,
    ).toBe(200);
    await api("PATCH", route + "/choices", {
      choices: [{ suggestion_id: "fix", status: "accepted" }],
    });
    expect(
      (await api("POST", route + "/apply", { client_apply_id: "crlf" })).status,
    ).toBe(200);
    expect(fs.readFileSync(pathname, "utf8")).toBe("Alpha\r\nFinal");
  });
  test("executor findings use existing inline comments and operator threads", async () => {
    const { d, review, submission_token } = await assignment("inline");
    await submit(d, review, submission_token);
    const detail = await api("GET", `/${d.id}`);
    expect(detail.body.inline_comments).toHaveLength(4);
    const suggestion = detail.body.inline_comments.find(
      (c) => c.suggestion_id === "s1",
    );
    expect(suggestion.author.authority).toBe("assigned_executor");
    expect(suggestion.kind).toBe("passage");
    expect(suggestion.quote).toBe("Alpha Beta Gamma");
    expect(suggestion.suggestion.original).toBe("Alpha");
    expect(db.documentReviews.listComments(review.id)).toHaveLength(4);
    const reply = await api("POST", `/reviews/${review.id}/comments`, {
      parent_id: suggestion.id,
      kind: "document",
      body: "Keep this on hold",
      client_id: "inline-reply",
    });
    expect(reply.status).toBe(201);
    expect(
      (
        await api("PATCH", `/reviews/${review.id}/comments/${suggestion.id}`, {
          body: "Overwrite executor",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api("PATCH", `/reviews/${review.id}/comments/${suggestion.id}`, {
          resolved: true,
        })
      ).status,
    ).toBe(200);
    const after = await api("GET", `/${d.id}`);
    expect(after.body.inline_comments).toHaveLength(5);
    expect(
      after.body.inline_comments.find((c) => c.parent_id === suggestion.id)
        .author.id,
    ).toBe("operator");
  });
  test("legacy migration repeats without dropping originals, choices, attribution or replies", async () => {
    const { d, review } = await assignment("legacy-inline");
    await db.updateTask("task", { default_executor: "claude" });
    const original = db.agentReviews.get(review.id);
    const comment = {
      id: "observation",
      body: "Original executor note",
      start: 0,
      end: 5,
      original: "Alpha",
      author: original.author,
      resolved: true,
      replies: [
        {
          id: "legacy-reply",
          body: "Please wait",
          author: { id: "operator", authority: "operator_credential" },
        },
      ],
    };
    const suggestion = {
      id: "suggestion",
      start: 6,
      end: 10,
      original: "Beta",
      proposed: "Second",
      explanation: "Original explanation",
    };
    const choices = [
      {
        suggestion_id: "suggestion",
        status: "accepted",
        replacement: "Edited",
      },
    ];
    db.agentReviews.save({
      ...original,
      status: "submitted",
      client_submission_id: "legacy",
      submitted_at: new Date().toISOString(),
      comments: [comment],
      suggestions: [suggestion],
      choices,
    });
    const {
      migrateAgentReviewComments,
    } = require("../services/document-unified-comments");
    expect(
      migrateAgentReviewComments(db, {
        reviewId: review.id,
        documentId: d.id,
      })[0].migrated,
    ).toBe(true);
    const first = db.documentReviews.listComments(review.id);
    expect(first).toHaveLength(3);
    expect(first.find((c) => !c.parent_id).author.name).toBe("Claude");
    expect(
      migrateAgentReviewComments(db, {
        reviewId: review.id,
        documentId: d.id,
      })[0].migrated,
    ).toBe(false);
    expect(db.documentReviews.listComments(review.id)).toEqual(first);
    const restored = db.agentReviews.get(review.id);
    expect(restored.choices).toEqual(choices);
    expect(restored.comments[0]).toMatchObject({
      body: comment.body,
      original: "Alpha",
      resolved: true,
    });
    expect(restored.comments[0].replies[0].body).toBe("Please wait");
    expect(restored.suggestions[0]).toMatchObject(suggestion);
    const listed = await api("GET", `/${d.id}`);
    expect(listed.body.inline_comments).toHaveLength(3);
    expect(
      listed.body.inline_comments.find((c) => c.suggestion_id === "suggestion")
        .choice.replacement,
    ).toBe("Edited");
  });
  test("applied suggestions remain visible as historical anchored comments", async () => {
    const { d, review, submission_token } =
      await assignment("historical-inline");
    await submit(d, review, submission_token);
    const route = `/${d.id}/agent-reviews/${review.id}`;
    await api("PATCH", route + "/choices", {
      choices: [
        { suggestion_id: "s1", status: "accepted" },
        { suggestion_id: "s2", status: "rejected" },
      ],
    });
    await api("POST", route + "/apply", { client_apply_id: "historical" });
    const comments = (await api("GET", `/${d.id}`)).body.inline_comments;
    expect(comments).toHaveLength(4);
    expect(
      comments.every(
        (c) => c.historical && c.revision_id === d.current_revision_id,
      ),
    ).toBe(true);
    expect(comments.find((c) => c.suggestion_id === "s1").anchor.state).toBe(
      "orphaned",
    );
    expect(comments.find((c) => c.suggestion_id === "s2").choice.status).toBe(
      "rejected",
    );
    expect(comments.find((c) => c.suggestion_id === "s3").choice.status).toBe(
      "pending",
    );
  });
  test("summary-only no-changes assessment is visible in the shared comment list", async () => {
    const { d, review, submission_token } =
      await assignment("assessment-inline");
    const route = `/${d.id}/agent-reviews/${review.id}`;
    const input = {
      client_submission_id: "assessment",
      summary: "No changes needed; wording is clear.",
      comments: [],
      suggestions: [],
    };
    expect(
      (await api("POST", route + "/submit", input, submission_token)).status,
    ).toBe(200);
    expect(
      (await api("POST", route + "/submit", input, submission_token)).status,
    ).toBe(200);
    const comments = (await api("GET", `/${d.id}`)).body.inline_comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      kind: "document",
      body: input.summary,
      author: { authority: "assigned_executor" },
    });
    expect(
      (await api("POST", route + "/apply", { client_apply_id: "finish" })).body
        .no_changes,
    ).toBe(true);
  });
  test("operator converts whole-document feedback with explicit range, keeping executor origin immutable and applying one batch", async () => {
    const { d, review, submission_token } = await assignment("convert");
    await submit(d, review, submission_token);
    const original = (await api("GET", `/${d.id}`)).body.inline_comments.find(
      (c) => !c.suggestion,
    );
    const before = db.documentReviews.getComment(original.id);
    const route = `/reviews/${review.id}/comments/${original.id}/suggestion`;
    const input = {
      client_request_id: "conversion",
      proposed: "",
      status: "accepted",
      start: 0,
      end: 5,
      original: "Alpha",
    };
    expect((await api("POST", route, input, submission_token)).status).toBe(
      403,
    );
    expect(
      (
        await api("POST", route, {
          client_request_id: "missing-range",
          proposed: "Different",
          status: "accepted",
        })
      ).body.code,
    ).toBe("range_required");
    const converted = await api("POST", route, input);
    expect(converted.status).toBe(201);
    expect(converted.body.comment).toMatchObject({
      source_comment_id: original.id,
      author: { id: "operator", authority: "operator_credential" },
      suggestion: { original: "Alpha", proposed: "" },
      choice: { status: "accepted" },
    });
    expect(fs.readFileSync(file, "utf8")).toBe("Alpha Beta Gamma");
    expect(
      (
        await api("POST", route, {
          ...input,
          client_request_id: "lost-response-new-id",
        })
      ).body.comment.id,
    ).toBe(converted.body.comment.id);
    expect(
      (
        await api("POST", route, {
          ...input,
          client_request_id: "second-proposal",
          proposed: "Another",
        })
      ).body.code,
    ).toBe("already_converted");
    expect(
      db.documentReviews
        .listComments(review.id)
        .filter((c) => c.provenance?.source_comment_id === original.id),
    ).toHaveLength(1);
    expect(db.documentReviews.getComment(original.id)).toEqual(before);
    expect((await api("POST", route, input)).body.comment.id).toBe(
      converted.body.comment.id,
    );
    expect(
      (await api("POST", route, { ...input, proposed: "Changed" })).status,
    ).toBe(409);
    const target = `/${d.id}/agent-reviews/${review.id}`;
    await api("PATCH", target + "/choices", {
      choices: [{ suggestion_id: "s2", status: "accepted" }],
    });
    expect(
      (await api("POST", target + "/apply", { client_apply_id: "combined" }))
        .status,
    ).toBe(200);
    expect(fs.readFileSync(file, "utf8")).toBe(" Second Gamma");
    expect((await api("POST", route, input)).body.comment.id).toBe(
      converted.body.comment.id,
    );
  });
  test("conversion refuses stale source and preserves original feedback", async () => {
    const { d, review, submission_token } = await assignment("convert-stale");
    await submit(d, review, submission_token);
    const comment = (await api("GET", `/${d.id}`)).body.inline_comments.find(
      (c) => !c.suggestion,
    );
    fs.writeFileSync(file, "External edit");
    const response = await api(
      "POST",
      `/reviews/${review.id}/comments/${comment.id}/suggestion`,
      {
        client_request_id: "stale-convert",
        proposed: "Replacement",
        status: "accepted",
        start: 0,
        end: 5,
        original: "Alpha",
      },
    );
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("stale_revision");
    expect(db.documentReviews.listComments(review.id)).toHaveLength(4);
    expect(fs.readFileSync(file, "utf8")).toBe("External edit");
  });
  test("passage conversion uses immutable exact range and does not change the sealed executor submission", async () => {
    const { d, review, submission_token } = await assignment("convert-passage");
    const target = `/${d.id}/agent-reviews/${review.id}`;
    const input = {
      client_submission_id: "passage",
      summary: "Observation",
      comments: [
        {
          id: "passage",
          body: "This opening needs clarity",
          start: 0,
          end: 5,
          original: "Alpha",
        },
      ],
      suggestions: [],
    };
    await api("POST", target + "/submit", input, submission_token);
    const sealed = db.agentReviews.get(review.id);
    const original = (await api("GET", `/${d.id}`)).body.inline_comments[0];
    const route = `/reviews/${review.id}/comments/${original.id}/suggestion`;
    const result = await api("POST", route, {
      client_request_id: "precise",
      proposed: "Opening",
      status: "pending",
    });
    expect(result.status).toBe(201);
    expect(result.body.comment.suggestion).toMatchObject({
      start: 0,
      end: 5,
      original: "Alpha",
      proposed: "Opening",
    });
    expect(result.body.comment.choice.status).toBe("pending");
    const after = db.agentReviews.get(review.id);
    expect(after.receipt).toEqual(sealed.receipt);
    expect(after.submission_hash).toBe(sealed.submission_hash);
    expect(after.comments[0].body).toBe("This opening needs clarity");
    expect(after.suggestions[0]).toMatchObject({
      origin: "operator",
      author: { authority: "operator_credential" },
      source_comment_id: original.id,
    });
    expect(
      (await api("POST", target + "/submit", input, submission_token)).body
        .receipt.id,
    ).toBe(sealed.receipt.id);
    expect(
      (
        await api("POST", route, {
          client_request_id: "wrong-range",
          proposed: "Changed",
          status: "accepted",
          start: 6,
          end: 10,
          original: "Beta",
        })
      ).body.code,
    ).toBe("range_mismatch");
    expect(fs.readFileSync(file, "utf8")).toBe("Alpha Beta Gamma");
  });
  test("Praxis generates one pending source-linked proposal with canonical context, never acceptance or source edits", async () => {
    proposalCompletion.mockReset().mockResolvedValue({
      text: JSON.stringify({
        original: "Alpha",
        proposed: "A clearer opening",
        explanation: "Clarifies the opening",
      }),
      servedBy: "configured-model",
      finishReason: "stop",
    });
    const { d, review, submission_token } = await assignment("generate");
    await submit(d, review, submission_token);
    const source = (await api("GET", `/${d.id}`)).body.inline_comments.find(
      (c) => !c.suggestion,
    );
    const before = db.documentReviews.getComment(source.id);
    const route = `/reviews/${review.id}/comments/${source.id}/proposal`;
    expect(
      (
        await api(
          "POST",
          route,
          { client_request_id: "generate" },
          submission_token,
        )
      ).status,
    ).toBe(403);
    expect(proposalCompletion).not.toHaveBeenCalled();
    const result = await api("POST", route, { client_request_id: "generate" });
    expect(result.status).toBe(201);
    expect(result.body.comment).toMatchObject({
      source_comment_id: source.id,
      author: { name: "Praxis", authority: "praxis_proposal" },
      suggestion: { original: "Alpha", proposed: "A clearer opening" },
      choice: { status: "pending" },
    });
    expect(
      result.body.review.suggestions.find(
        (s) => s.id === result.body.comment.suggestion.id,
      ).origin,
    ).toBe("praxis");
    expect(fs.readFileSync(file, "utf8")).toBe("Alpha Beta Gamma");
    expect(db.documentReviews.getComment(source.id)).toEqual(before);
    expect(
      (await api("POST", route, { client_request_id: "generate" })).body.comment
        .id,
    ).toBe(result.body.comment.id);
    expect(
      (await api("POST", route, { client_request_id: "different-request" }))
        .body.comment.id,
    ).toBe(result.body.comment.id);
    expect(proposalCompletion).toHaveBeenCalledTimes(1);
    const args = proposalCompletion.mock.calls[0];
    expect(args[0]).toContain("Alpha Beta Gamma");
    expect(args[0]).toContain(source.body);
    expect(args[4]).toEqual([]);
    expect(args[5]).toMatchObject({ role: "brain.chat", requireNoTools: true });
  });
  test("malformed, truncated and ambiguous model output fails without a proposal or automatic retry spend", async () => {
    for (const [name, result] of [
      ["malformed", { text: "not json" }],
      ["truncated", { text: "{}", truncated: true }],
      [
        "ambiguous",
        {
          text: JSON.stringify({
            original: "a",
            proposed: "letter",
            explanation: "Edit",
          }),
        },
      ],
    ]) {
      proposalCompletion.mockReset().mockResolvedValue(result);
      const { d, review, submission_token } = await assignment(
        "generate-" + name,
      );
      await submit(d, review, submission_token);
      const source = (await api("GET", `/${d.id}`)).body.inline_comments.find(
        (c) => !c.suggestion,
      );
      const route = `/reviews/${review.id}/comments/${source.id}/proposal`;
      const failed = await api("POST", route, { client_request_id: name });
      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect(failed.body.retry_with_new_request_id).toBe(true);
      expect(
        (await api("POST", route, { client_request_id: name })).status,
      ).toBeGreaterThanOrEqual(400);
      expect(proposalCompletion).toHaveBeenCalledTimes(1);
      expect(db.documentReviews.listComments(review.id)).toHaveLength(4);
    }
  });
  test("source changes while model generates refuse its output and retain original findings", async () => {
    const { d, review, submission_token } = await assignment("generate-stale");
    await submit(d, review, submission_token);
    const source = (await api("GET", `/${d.id}`)).body.inline_comments.find(
      (c) => !c.suggestion,
    );
    proposalCompletion.mockReset().mockImplementation(async () => {
      fs.writeFileSync(file, "Changed during generation");
      return {
        text: JSON.stringify({
          original: "Alpha",
          proposed: "New",
          explanation: "Edit",
        }),
      };
    });
    const failed = await api(
      "POST",
      `/reviews/${review.id}/comments/${source.id}/proposal`,
      { client_request_id: "stale-model" },
    );
    expect(failed.status).toBe(409);
    expect(failed.body.code).toBe("stale_revision");
    expect(db.documentReviews.listComments(review.id)).toHaveLength(4);
    expect(fs.readFileSync(file, "utf8")).toBe("Changed during generation");
  });
  test("durable ready output resumes without a second model call and interrupted attempt requires explicit retry", async () => {
    proposalCompletion
      .mockReset()
      .mockResolvedValue({
        text: JSON.stringify({
          original: "Alpha",
          proposed: "Fresh wording",
          explanation: "Clarity",
        }),
      });
    const { d, review, submission_token } = await assignment("generate-resume");
    await submit(d, review, submission_token);
    const source = (await api("GET", `/${d.id}`)).body.inline_comments.find(
      (c) => !c.suggestion,
    );
    const route = `/reviews/${review.id}/comments/${source.id}/proposal`;
    db.agentReviews.saveProposalJob({
      review_id: review.id,
      source_comment_id: source.id,
      client_request_id: "resume",
      state: "output_ready",
      result: {
        text: JSON.stringify({
          original: "Alpha",
          proposed: "Recovered wording",
          explanation: "Clarity",
        }),
      },
    });
    const resumed = await api("POST", route, { client_request_id: "resume" });
    expect(resumed.status).toBe(201);
    expect(resumed.body.comment.suggestion.proposed).toBe("Recovered wording");
    expect(proposalCompletion).not.toHaveBeenCalled();
    const next = await assignment("generate-interrupted");
    await submit(next.d, next.review, next.submission_token);
    const other = (await api("GET", `/${next.d.id}`)).body.inline_comments.find(
      (c) => !c.suggestion,
    );
    const nextRoute = `/reviews/${next.review.id}/comments/${other.id}/proposal`;
    db.agentReviews.saveProposalJob({
      review_id: next.review.id,
      source_comment_id: other.id,
      client_request_id: "interrupted",
      state: "generating",
      owner: "previous-process",
      pid: process.pid,
      started_at: new Date(0).toISOString(),
      expires_at: 1,
    });
    const interrupted = await api("POST", nextRoute, {
      client_request_id: "interrupted",
    });
    expect(interrupted.body.code).toBe("proposal_interrupted");
    expect(interrupted.body.retry_with_new_request_id).toBe(true);
    expect(proposalCompletion).not.toHaveBeenCalled();
    const retried = await api("POST", nextRoute, {
      client_request_id: "explicit-retry",
    });
    expect(retried.status).toBe(201);
    expect(proposalCompletion).toHaveBeenCalledTimes(1);
  });
  test("concurrent generation requests for one source share one pending proposal and model call", async () => {
    const { d, review, submission_token } = await assignment(
      "generate-concurrent",
    );
    await submit(d, review, submission_token);
    const source = (await api("GET", `/${d.id}`)).body.inline_comments.find(
      (c) => !c.suggestion,
    );
    let release;
    proposalCompletion.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const {
      createPraxisProposalGenerator,
    } = require("../services/document-praxis-proposals");
    const generate = createPraxisProposalGenerator({
      db,
      complete: proposalCompletion,
      reviewability: () => ({ ok: true }),
      reconcileReplacement: async () => null,
    });
    const args = {
      reviewId: review.id,
      commentId: source.id,
      clientRequestId: "first",
      actor: { id: "operator", authority: "operator_credential" },
    };
    const first = generate(args),
      second = generate({ ...args, clientRequestId: "second" });
    expect(first).toBe(second);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    release({
      text: JSON.stringify({
        original: "Alpha",
        proposed: "Concurrent wording",
        explanation: "Clarity",
      }),
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.comment.id).toBe(b.comment.id);
    expect(proposalCompletion).toHaveBeenCalledTimes(1);
    expect(a.comment.choice.status).toBe("pending");
  });
});

test("attribution uses actual dispatch rather than QA or requested default", () => {
  const raw = new Database(":memory:");
  raw.exec(
    "CREATE TABLE tasks(id TEXT,default_executor TEXT);CREATE TABLE task_dispatches(id TEXT,task_id TEXT,executor TEXT,kind TEXT,started_at TEXT);INSERT INTO tasks VALUES('task','codex');INSERT INTO task_dispatches VALUES('actual','task','claude-code','dispatch','2026-11-01T10:00:00Z'),('qa','task','codex','qa','2026-11-01T10:01:00Z'),('later','task','codex','dispatch','2026-11-01T12:00:00Z');",
  );
  const agents = createAgentReviewStore(raw);
  expect(
    agents.assignmentAuthor(
      "task",
      { id: "task", authority: "assigned_executor" },
      "2026-11-01T11:00:00Z",
    ),
  ).toMatchObject({
    id: "task",
    name: "Claude",
    dispatch_id: "actual",
    attribution_source: "task_dispatches",
  });
  raw.close();
});
