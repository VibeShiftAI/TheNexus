import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { DocumentReviewPage } from "../document-review/document-review.tsx";
const content = "# Report\n\nOld text here.\n";
const revision = {
  id: "v5",
  document_id: "doc",
  content_hash: "a".repeat(64),
  byte_length: content.length,
  line_count: 3,
  captured_at: "2026-11-01T00:00:00Z",
  version: 5,
};
const suggestion = {
  id: "s1",
  start: 10,
  end: 13,
  original: "Old",
  proposed: "New",
  explanation: "Use clearer wording",
};
const finding = {
  id: "inline-s1",
  review_id: "round-agent",
  agent_review_id: "agent",
  suggestion_id: "s1",
  author: { id: "Claude reviewer", authority: "assigned_executor" },
  kind: "passage",
  start_line: 3,
  end_line: 3,
  quote: "Old",
  body: suggestion.explanation,
  suggestion,
  choice: { suggestion_id: "s1", status: "pending" },
  anchor: { state: "intact", current_start_line: 3 },
  created_at: "2026-11-01T00:00:00Z",
};
const observation = {
  ...finding,
  id: "inline-c1",
  suggestion_id: undefined,
  suggestion: undefined,
  choice: undefined,
  kind: "document",
  start_line: null,
  end_line: null,
  quote: null,
  body: "Check the date.",
  anchor: { state: "document" },
};
const review = {
  id: "agent",
  document_id: "doc",
  base_revision_id: "v5",
  task_id: "task",
  author: { id: "Claude reviewer" },
  status: "submitted",
  summary: "",
  comments: [],
  suggestions: [suggestion],
  choices: [finding.choice],
};
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
const button = (c, label) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const click = async (b) => {
  assert.ok(b);
  await act(async () => b.click());
  await settle();
};
const type = async (a, v) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(a, v);
    a.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
if (!window.HTMLElement.prototype.scrollIntoView)
  window.HTMLElement.prototype.scrollIntoView = function () {};
for (const loseConversionResponse of [false, true])
  test(`executor findings share inline cards and preserve conversion recovery (lost response: ${loseConversionResponse})`, async () => {
    localStorage.clear();
    let saved = structuredClone(review);
    let comments = structuredClone([
      finding,
      observation,
      {
        ...observation,
        id: "inline-old",
        kind: "passage",
        start_line: 3,
        end_line: 3,
        revision_id: "v4",
        historical: true,
        body: "Earlier finding",
        anchor: { state: "orphaned", current_start_line: null },
      },
    ]);
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(String(url), "http://localhost").pathname;
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ path, body });
      let data = {};
      let status = 200;
      if (path === "/api/documents/doc")
        data = {
          document: {
            id: "doc",
            title: "Report",
            path: "/tmp/report.md",
            kind: "report",
            current_revision_id: "v5",
            metadata: {},
          },
          revision,
          content,
          file_state: "ok",
          source: { task: null, project: null },
          viewer: { id: "local_user" },
          links: {},
          review: null,
          inline_comments: comments,
        };
      else if (path.endsWith("/choices")) {
        saved = { ...saved, choices: body.choices };
        comments = comments.map((c) =>
          c.suggestion ? { ...c, choice: body.choices[0] } : c,
        );
        data = { review: saved };
      } else if (path.endsWith("/inline-c1/suggestion")) {
        if (comments.some((comment) => comment.id === "converted"))
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: "This comment already has a suggested edit",
              code: "already_converted",
            }),
          };
        const derivedSuggestion = {
          id: "derived",
          start: body.start,
          end: body.end,
          original: body.original,
          proposed: body.proposed,
          explanation: "Operator replacement",
        };
        const choice = { suggestion_id: "derived", status: body.status };
        const derived = {
          ...finding,
          id: "converted",
          source_comment_id: "inline-c1",
          author: { id: "local_user", name: "Robert" },
          suggestion: derivedSuggestion,
          suggestion_id: "derived",
          choice,
          body: "Operator replacement",
        };
        comments = [...comments, derived];
        saved = {
          ...saved,
          suggestions: [...saved.suggestions, derivedSuggestion],
          choices: [...saved.choices, choice],
        };
        data = loseConversionResponse
          ? { error: "Response lost after save" }
          : { comment: derived, review: saved };
        if (loseConversionResponse) status = 503;
      } else if (path.endsWith("/apply")) {
        status = 409;
        data = { error: "Source changed. Request a fresh review." };
      } else if (path === "/api/documents/reviews/round-agent/comments") {
        const reply = {
          ...observation,
          id: "reply",
          parent_id: body.parent_id,
          body: body.body,
          author: { id: "local_user" },
          client_id: body.client_id,
        };
        comments = [...comments, reply];
        data = { comment: reply };
      } else if (path.endsWith("/inline-c1")) {
        comments = comments.map((c) =>
          c.id === "inline-c1" ? { ...c, resolved: body.resolved } : c,
        );
        data = { comment: comments.find((c) => c.id === "inline-c1") };
      } else if (path.endsWith("/agent-reviews/agent"))
        data = {
          review: saved,
          revision: { ...revision, content },
          current_revision_id: "v5",
        };
      else if (path.endsWith("/agent-reviews")) data = { reviews: [saved] };
      else {
        status = 404;
        data = { error: "Unexpected " + path };
      }
      return { ok: status < 400, status, json: async () => data };
    };
    const c = document.createElement("div");
    document.body.append(c);
    let root = createRoot(c);
    const reload = async () => {
      act(() => root.unmount());
      root = createRoot(c);
      await act(async () =>
        root.render(createElement(DocumentReviewPage, { documentId: "doc" })),
      );
      await settle();
    };
    try {
      await act(async () =>
        root.render(createElement(DocumentReviewPage, { documentId: "doc" })),
      );
      await settle();
      assert.ok(
        !c.querySelector('[aria-label="Executor reviews"]'),
        "no separate review panel",
      );
      const card = c.querySelector(
        '[data-comment-list] [data-comment-id="inline-s1"]',
      );
      assert.ok(card, "suggestion is an existing inline comment card");
      assert.match(card.textContent, /Claude reviewer/);
      assert.match(card.textContent, /Suggested edit/);
      assert.ok(
        !card.querySelector("[data-comment-resolve]"),
        "suggestions have no competing Resolve action",
      );
      assert.equal(card.querySelectorAll("[data-comment-actions]").length, 1);
      assert.ok(
        card.querySelector("[data-comment-actions] [data-comment-reply]"),
      );
      assert.match(
        c.querySelector('[data-comment-id="inline-c1"]').textContent,
        /Comment — no text change/,
      );
      assert.deepEqual(
        [...c.querySelector("[data-comment-list]").children].map(
          (e) => e.dataset.commentId,
        ),
        ["inline-c1", "inline-s1", "inline-old"],
      );
      assert.ok(
        c.querySelector('[data-comment-id="inline-old"] [data-comment-jump]')
          .disabled,
      );
      assert.ok(card.querySelector("[data-comment-jump]"));
      assert.match(
        c.querySelector("#L3 [data-block-comment-button]").textContent,
        /1/,
      );
      await click(button(card, "Edit & accept"));
      await type(card.querySelector("textarea"), "");
      await reload();
      assert.equal(
        c.querySelector('[data-comment-id="inline-s1"] textarea').value,
        "",
      );
      await click(
        button(
          c.querySelector('[data-comment-id="inline-s1"]'),
          "Save edited choice",
        ),
      );
      assert.equal(saved.choices[0].replacement, "");
      await click(
        button(
          c.querySelector('[data-comment-id="inline-s1"]'),
          "Undo decision",
        ),
      );
      assert.equal(saved.choices[0].status, "pending");
      await click(
        button(c.querySelector('[data-comment-id="inline-s1"]'), "Accept"),
      );
      assert.equal(
        c.querySelector("[data-combined-preview]").textContent,
        "# Report\n\n text here.\n",
      );
      await click(button(c, "Apply accepted changes"));
      assert.match(c.textContent, /Source changed/);
      const comment = c.querySelector('[data-comment-id="inline-c1"]');
      await click(comment.querySelector("[data-comment-reply]"));
      await type(c.querySelector("[data-composer] textarea"), "Date confirmed");
      await reload();
      assert.equal(
        c.querySelector("[data-composer] textarea").value,
        "Date confirmed",
      );
      await click(button(c.querySelector("[data-composer]"), "Save comment"));
      assert.ok(
        calls.some(
          (x) =>
            x.path === "/api/documents/reviews/round-agent/comments" &&
            x.body.parent_id === "inline-c1",
        ),
      );
      assert.match(
        c.querySelector("[data-comment-replies]").textContent,
        /Date confirmed/,
      );
      await click(
        c.querySelector('[data-comment-id="inline-c1"] [data-comment-resolve]'),
      );
      assert.match(
        c.querySelector('[data-comment-id="inline-c1"]').textContent,
        /resolved/,
      );
      // A pre-existing manual draft remains recoverable after generation became the default.
      act(() => root.unmount());
      const draftKey = "nexus:inline-suggestions:doc";
      const kept = JSON.parse(localStorage.getItem(draftKey) || "{}");
      localStorage.setItem(
        draftKey,
        JSON.stringify({
          ...kept,
          conversions: {
            "inline-c1": { text: "", clientRequestId: "retained-manual" },
          },
        }),
      );
      root = createRoot(c);
      await act(async () =>
        root.render(createElement(DocumentReviewPage, { documentId: "doc" })),
      );
      await settle();
      await click(
        button(
          c.querySelector('[data-comment-id="inline-c1"]'),
          "Choose passage",
        ),
      );
      assert.match(
        c.querySelector("[data-comment-conversion]").textContent,
        /Select the exact passage/,
      );
      assert.ok(
        !c.querySelector('textarea[aria-label="Proposed replacement"]'),
      );
      await click(c.querySelector("#L3 [data-block-comment-button]"));
      await type(
        c.querySelector('textarea[aria-label="Proposed replacement"]'),
        "Revised passage.",
      );
      await reload();
      assert.equal(
        c.querySelector('textarea[aria-label="Proposed replacement"]').value,
        "Revised passage.",
      );
      await click(
        button(c.querySelector('[data-comment-id="inline-c1"]'), "Accept edit"),
      );
      if (loseConversionResponse) {
        assert.equal(
          c.querySelector('textarea[aria-label="Proposed replacement"]').value,
          "Revised passage.",
        );
        await type(
          c.querySelector('textarea[aria-label="Proposed replacement"]'),
          "Changed replacement.",
        );
        await click(
          button(
            c.querySelector('[data-comment-id="inline-c1"]'),
            "Accept edit",
          ),
        );
        assert.match(
          c.querySelector('[data-comment-id="converted"]').textContent,
          /Changed replacement/,
        );
        assert.ok(
          button(
            c.querySelector('[data-comment-id="converted"]'),
            "Use retained text",
          ),
        );
        const attempts = calls.filter((call) =>
          call.path.endsWith("/inline-c1/suggestion"),
        );
        assert.notEqual(
          attempts[0].body.client_request_id,
          attempts[1].body.client_request_id,
        );
      }
      const conversion = calls.find((call) =>
        call.path.endsWith("/inline-c1/suggestion"),
      );
      assert.deepEqual(
        [
          conversion.body.start,
          conversion.body.end,
          conversion.body.original,
          conversion.body.proposed,
        ],
        [10, 24, "Old text here.", "Revised passage."],
      );
      assert.ok(
        !c.querySelector('[data-comment-list] > [data-comment-id="inline-c1"]'),
      );
      assert.match(
        c.querySelector('[data-comment-id="converted"]').textContent,
        /Check the date/,
      );
      assert.match(
        c.querySelector('[data-comment-id="converted"] [data-comment-replies]')
          .textContent,
        /Date confirmed/,
      );
      assert.match(c.textContent, /overlap/);
      assert.ok(button(c, "Apply accepted changes").disabled);
    } finally {
      act(() => root.unmount());
      c.remove();
      globalThis.fetch = original;
    }
  });

test("Praxis generation retries into a pending proposal, card selection highlights source, controls and refresh never scroll", async () => {
  localStorage.clear();
  const originalFetch = globalThis.fetch;
  const originalScroll = window.HTMLElement.prototype.scrollIntoView;
  const scrolls = [];
  window.HTMLElement.prototype.scrollIntoView = function () {
    scrolls.push(this);
  };
  let saved = { ...review, suggestions: [], choices: [] };
  let comments = [{ ...observation, revision_id: "v5" }];
  let release;
  let attempts = 0;
  let currentContent = content;
  let currentRevision = "v5";
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, body });
    let data;
    let status = 200;
    if (path === "/api/documents/doc")
      data = {
        document: {
          id: "doc",
          title: "Report",
          path: "/tmp/report.md",
          kind: "report",
          current_revision_id: currentRevision,
          metadata: {},
        },
        revision: { ...revision, id: currentRevision },
        content: currentContent,
        file_state: "ok",
        source: { task: null, project: null },
        viewer: { id: "local_user" },
        links: {},
        review: null,
        inline_comments: comments,
      };
    else if (path.endsWith("/proposal")) {
      attempts++;
      if (attempts === 1) {
        await new Promise((resolve) => {
          release = resolve;
        });
        status = 503;
        data = {
          error: "Gateway unavailable",
          retry_with_new_request_id: true,
        };
      } else {
        const proposed = {
          ...suggestion,
          id: "praxis-edit",
          proposed: "Updated",
        };
        const choice = { suggestion_id: proposed.id, status: "pending" };
        const generated = {
          ...finding,
          id: "praxis-card",
          revision_id: "v5",
          source_comment_id: "inline-c1",
          author: {
            id: "praxis",
            name: "Praxis",
            authority: "praxis_proposal",
          },
          suggestion: proposed,
          choice,
        };
        comments = [...comments, generated];
        saved = { ...saved, suggestions: [proposed], choices: [choice] };
        data = { comment: generated, review: saved };
      }
    } else if (path.endsWith("/agent-reviews/agent"))
      data = {
        review: saved,
        revision: { ...revision, content },
        current_revision_id: currentRevision,
      };
    else {
      status = 404;
      data = { error: "Unexpected " + path };
    }
    return { ok: status < 400, status, json: async () => data };
  };
  const c = document.createElement("div");
  document.body.append(c);
  const root = createRoot(c);
  try {
    await act(async () =>
      root.render(createElement(DocumentReviewPage, { documentId: "doc" })),
    );
    await settle();
    act(() => button(c, "Turn into suggested edit").click());
    await settle();
    assert.match(c.textContent, /Praxis is drafting/);
    assert.ok(!c.querySelector('textarea[aria-label="Proposed replacement"]'));
    release();
    await settle();
    assert.match(c.textContent, /Gateway unavailable/);
    await click(button(c, "Retry generation"));
    const proposals = calls.filter((call) => call.path.endsWith("/proposal"));
    assert.equal(proposals.length, 2);
    assert.notEqual(
      proposals[0].body.client_request_id,
      proposals[1].body.client_request_id,
    );
    assert.deepEqual(Object.keys(proposals[1].body), ["client_request_id"]);
    const card = c.querySelector('[data-comment-id="praxis-card"]');
    assert.match(card.textContent, /Praxis/);
    assert.match(card.textContent, /Suggested edit · pending/);
    assert.doesNotMatch(card.textContent, /Your suggested edit/);
    assert.equal(
      calls.filter(
        (call) =>
          call.path.endsWith("/choices") || call.path.endsWith("/apply"),
      ).length,
      0,
    );
    await click(card.querySelector("pre"));
    assert.equal(
      c.querySelector("[data-stage] mark[data-suggestion-highlight]")
        ?.textContent,
      "Old",
    );
    assert.ok(scrolls.length > 0);
    const afterSelect = scrolls.length;
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.equal(
      scrolls.length,
      afterSelect,
      "unchanged background reads do not scroll",
    );
    await click(button(card, "Edit & accept"));
    const parses = globalThis.__documentMarkdownParses;
    await type(card.querySelector("textarea"), "Adjusted");
    await type(card.querySelector("textarea"), "Adjusted wording");
    assert.equal(
      globalThis.__documentMarkdownParses,
      parses,
      "typing does not reparse",
    );
    assert.equal(
      scrolls.length,
      afterSelect,
      "controls do not select or scroll",
    );
    currentContent = "# Report\n\nChanged passage.";
    currentRevision = "v6";
    comments = comments.map((comment) => ({
      ...comment,
      historical: true,
      anchor: { state: "orphaned", current_start_line: null },
    }));
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    await click(c.querySelector('[data-comment-id="praxis-card"] p'));
    assert.ok(!c.querySelector("[data-stage] mark[data-suggestion-highlight]"));
    assert.match(
      c.querySelector("[data-highlight-unavailable]").textContent,
      /earlier or changed passage/,
    );
  } finally {
    act(() => root.unmount());
    c.remove();
    globalThis.fetch = originalFetch;
    window.HTMLElement.prototype.scrollIntoView = originalScroll;
  }
});
