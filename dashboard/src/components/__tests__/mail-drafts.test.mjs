import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { MailDrafts } from "../mail-drafts.tsx";
const runtime = {
  id: "runtime-1",
  subject: "Review me",
  body: "Original body",
  to: "you@example.com",
  cc: ["operator@example.com"],
  project: "Project One",
  taskId: "task-1",
  status: "draft",
  version: "v1",
  createdAt: "2026-10-22T12:00:00Z",
  updatedAt: "2026-10-22T12:00:00Z",
};
const response = (data, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
});
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const button = (c, text) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent === text);
async function click(b) {
  assert.ok(b);
  await act(async () => b.click());
  await settle();
}
async function input(el, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      "value",
    ).set.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
function setup(handler) {
  const old = globalThis.fetch;
  globalThis.fetch = handler;
  const c = document.createElement("div");
  document.body.append(c);
  const root = createRoot(c);
  act(() =>
    root.render(
      createElement(MailDrafts, { folder: "drafts", onCounts: () => {} }),
    ),
  );
  return {
    c,
    close() {
      act(() => root.unmount());
      c.remove();
      globalThis.fetch = old;
    },
  };
}
test("draft editing must be saved before exact-version approval", async () => {
  let item = { ...runtime };
  const writes = [];
  const t = setup(async (url, options = {}) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      writes.push(body);
      item = { ...item, ...body, version: "v2" };
      return response({ item });
    }
    return response({
      items: String(url).includes("/api/documents") ? [] : [item],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    assert.match(t.c.textContent, /Project One/);
    assert.ok(t.c.querySelector('a[href="/task/task-1"]'));
    await input(t.c.querySelector('[aria-label="Subject"]'), "Edited");
    assert.equal(button(t.c, "Approve and send").disabled, true);
    await click(button(t.c, "Save changes"));
    assert.equal(writes[0].action, "edit");
    await click(button(t.c, "Approve and send"));
    assert.equal(writes[1].action, "approve_send");
    assert.equal(writes[1].version, "v2");
  } finally {
    t.close();
  }
});
test("a failed source is visible alongside available drafts", async () => {
  const t = setup(async (url) =>
    String(url).includes("/api/documents")
      ? response({ error: "Document service unavailable" }, 503)
      : response({ items: [runtime], counts: { drafts: 1, cancelled: 0 } }),
  );
  try {
    await settle();
    assert.match(t.c.textContent, /Document service unavailable/);
    assert.match(t.c.textContent, /Review me/);
    assert.doesNotMatch(t.c.textContent, /No drafts/);
  } finally {
    t.close();
  }
});
test("return requires comments and sends no approval", async () => {
  let write;
  const t = setup(async (url, options = {}) => {
    if (options.method === "POST") {
      write = JSON.parse(options.body);
      return response({});
    }
    return response({
      items: String(url).includes("/api/documents") ? [] : [runtime],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    assert.equal(button(t.c, "Return to Praxis").disabled, true);
    await input(
      t.c.querySelector('[aria-label="Comments for Praxis"]'),
      "Please shorten",
    );
    await click(button(t.c, "Return to Praxis"));
    assert.deepEqual(write, {
      action: "return_to_praxis",
      version: "v1",
      comments: "Please shorten",
    });
  } finally {
    t.close();
  }
});
const docItem = {
  document: { id: "doc-1", task_id: "task-1" },
  project_name: "Project Document",
  task_name: "Write letter",
  outgoing: {
    status: "draft",
    revision_id: "rev-1",
    envelope_hash: "hash-1",
    envelope: {
      subject: "Document mail",
      text: "Exact text",
      to: "recipient@example.com",
      cc: ["operator@example.com"],
    },
    created_at: runtime.createdAt,
    updated_at: runtime.updatedAt,
  },
};
test("document return records hold first and retries feedback without another decision or grant", async () => {
  const writes = [];
  let fail = true;
  const t = setup(async (url, options = {}) => {
    const path = new URL(url, "http://localhost").pathname;
    if (options.method === "POST") {
      writes.push({ path, body: JSON.parse(options.body) });
      if (path.endsWith("/reviews"))
        return response({ review: { id: "review-1" } });
      if (path.endsWith("/finish") && fail)
        return response({ error: "Relay unavailable" }, 503);
      return response({});
    }
    return response({
      items: path.includes("/api/documents") ? [docItem] : [],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    await input(
      t.c.querySelector('[aria-label="Comments for Praxis"]'),
      "Make concise",
    );
    await click(button(t.c, "Return to Praxis"));
    assert.equal(writes[0].body.decision, "return_to_praxis");
    assert.equal(writes[0].body.envelope_hash, "hash-1");
    assert.match(t.c.textContent, /Sending is held and comments are saved/);
    assert.equal(button(t.c, "Approve and send"), undefined);
    fail = false;
    await click(button(t.c, "Retry feedback submission"));
    assert.equal(writes.filter((w) => w.path.endsWith("/decision")).length, 1);
    assert.ok(
      writes
        .filter((w) => w.path.endsWith("/finish"))
        .every((w) => w.body.approve_after_changes === undefined),
    );
  } finally {
    t.close();
  }
});
test("stale approval stops decisions until explicit reload", async () => {
  let writes = 0;
  const t = setup(async (url, options = {}) => {
    if (options.method === "POST") {
      writes++;
      return response({ error: "Draft changed" }, 409);
    }
    return response({
      items: String(url).includes("/api/documents") ? [] : [runtime],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    await click(button(t.c, "Approve and send"));
    assert.match(t.c.textContent, /Draft changed/);
    assert.equal(button(t.c, "Approve and send").disabled, true);
    assert.equal(writes, 1);
  } finally {
    t.close();
  }
});
for (const status of ["sent", "attempting", "uncertain", "cancelled"])
  test(`${status} exposes no mutating controls`, async () => {
    const t = setup(async (url) =>
      response({
        items: String(url).includes("/api/documents")
          ? []
          : [{ ...runtime, status }],
        counts: { drafts: 1, cancelled: 0 },
      }),
    );
    try {
      await settle();
      await click(t.c.querySelector("[data-draft-id]"));
      assert.equal(button(t.c, "Approve and send"), undefined);
      assert.equal(button(t.c, "Cancel send"), undefined);
      assert.equal(t.c.querySelector('[aria-label="Subject"]').disabled, true);
    } finally {
      t.close();
    }
  });
test("deep link selects a document draft without a decision", async () => {
  window.history.replaceState({}, "", "/mail?draft=doc-1");
  const t = setup(async (url) =>
    response({
      items: String(url).includes("/api/documents") ? [docItem] : [],
      counts: { drafts: 1, cancelled: 0 },
    }),
  );
  try {
    await settle();
    assert.equal(
      t.c.querySelector('[aria-label="Subject"]').value,
      "Document mail",
    );
    assert.match(t.c.textContent, /Write letter/);
  } finally {
    t.close();
    window.history.replaceState({}, "", "/");
  }
});
test("failed runtime feedback retries delivery without another return decision", async () => {
  let write;
  const t = setup(async (url, options = {}) => {
    if (options.method === "POST") {
      write = JSON.parse(options.body);
      return response({});
    }
    return response({
      items: String(url).includes("/api/documents")
        ? []
        : [
            {
              ...runtime,
              status: "returned",
              project: undefined,
              projectId: "project-42",
              feedback: [
                {
                  comments: "Revise it",
                  createdAt: runtime.updatedAt,
                  delivery: "failed",
                },
              ],
            },
          ],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    assert.match(t.c.textContent, /project-42/);
    assert.match(t.c.textContent, /delivery to Praxis failed/);
    await click(button(t.c, "Retry feedback submission"));
    assert.deepEqual(write, { action: "retry_feedback", version: "v1" });
  } finally {
    t.close();
  }
});

test("persisted document feedback can be resubmitted after a reload without a decision", async () => {
  const writes = [];
  const t = setup(async (url, options = {}) => {
    const path = new URL(url, "http://localhost").pathname;
    if (options.method === "POST") {
      writes.push(path);
      return response(
        path.endsWith("/reviews") ? { review: { id: "review-1" } } : {},
      );
    }
    return response({
      items: path.includes("/api/documents")
        ? [
            {
              ...docItem,
              outgoing: {
                ...docItem.outgoing,
                feedback: {
                  comments: "Saved feedback",
                  returned_at: runtime.updatedAt,
                  status: "changes_requested",
                },
              },
            },
          ]
        : [],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    await click(button(t.c, "Resubmit saved feedback"));
    assert.ok(writes.some((p) => p.endsWith("/finish")));
    assert.ok(writes.every((p) => !p.endsWith("/decision")));
  } finally {
    t.close();
  }
});
test("missing operator copy still allows holding or cancelling a message", async () => {
  const t = setup(async (url) =>
    response({
      items: String(url).includes("/api/documents")
        ? []
        : [{ ...runtime, blocked: "Operator copy missing" }],
      counts: { drafts: 1, cancelled: 0 },
    }),
  );
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    assert.equal(button(t.c, "Approve and send").disabled, true);
    assert.equal(button(t.c, "Cancel send").disabled, false);
    await input(
      t.c.querySelector('[aria-label="Comments for Praxis"]'),
      "Fix copy",
    );
    assert.equal(button(t.c, "Return to Praxis").disabled, false);
  } finally {
    t.close();
  }
});

test("reloaded document feedback reuses its existing failed submission", async () => {
  const writes = [];
  const t = setup(async (url, options = {}) => {
    const path = new URL(url, "http://localhost").pathname;
    if (options.method === "POST") {
      writes.push(path);
      return response({ submission: { delivery_status: "queued" } });
    }
    if (path === "/api/documents/doc-1")
      return response({
        review: {
          id: "existing-review",
          status: "submitted",
          summary: "Saved feedback",
          submitted_at: "2026-10-22T13:00:00Z",
          submission: { delivery_status: "failed" },
        },
      });
    return response({
      items: path.includes("/api/documents")
        ? [
            {
              ...docItem,
              outgoing: {
                ...docItem.outgoing,
                feedback: {
                  comments: "Saved feedback",
                  returned_at: runtime.updatedAt,
                  status: "changes_requested",
                },
              },
            },
          ]
        : [],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    assert.equal(button(t.c, "Approve and send").disabled, true);
    await click(button(t.c, "Resubmit saved feedback"));
    assert.deepEqual(writes, [
      "/api/documents/reviews/existing-review/submission/retry",
    ]);
  } finally {
    t.close();
  }
});

test("narrow screens replace the draft list with selection and offer a way back", async () => {
  const t = setup(async (url) =>
    response({
      items: String(url).includes("/api/documents") ? [] : [runtime],
      counts: { drafts: 1, cancelled: 0 },
    }),
  );
  try {
    await settle();
    const list = t.c.querySelector('[aria-label="Draft list"]');
    assert.equal(list.classList.contains("hidden"), false);
    await click(t.c.querySelector("[data-draft-id]"));
    assert.equal(list.classList.contains("hidden"), true);
    assert.equal(list.classList.contains("lg:block"), true);
    const back = button(t.c, "Back to drafts");
    assert.equal(back.classList.contains("lg:hidden"), true);
    assert.ok(t.c.querySelector('[aria-label="Draft detail"]'));
    await click(back);
    assert.equal(list.classList.contains("hidden"), false);
    assert.equal(t.c.querySelector('[aria-label="Draft detail"]'), null);
  } finally {
    t.close();
  }
});
test("blocked drafts are clearly held in the list before opening them", async () => {
  const t = setup(async (url) =>
    response({
      items: String(url).includes("/api/documents")
        ? []
        : [{ ...runtime, project: null, blocked: "Prior delivery uncertain" }],
      counts: { drafts: 1, cancelled: 0 },
    }),
  );
  try {
    await settle();
    const row = t.c.querySelector("[data-draft-id]");
    assert.match(row.textContent, /Held/);
    assert.doesNotMatch(row.textContent, /Awaiting approval/);
    assert.match(row.textContent, /No project/);
  } finally {
    t.close();
  }
});
test("a draft carrying an HTML part previews it in a sandboxed frame at phone width beside its plain-text alternative", async () => {
  const html = "<!doctype html><html><body><p>Status Report No. 15</p></body></html>";
  const t = setup(async (url) =>
    response({
      items: String(url).includes("/api/documents") ? [] : [{ ...runtime, html }],
      counts: { drafts: 1, cancelled: 0 },
    }),
  );
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    const frame = t.c.querySelector('iframe[title="HTML preview"]');
    assert.ok(frame);
    assert.equal(frame.getAttribute("srcdoc"), html);
    assert.equal(frame.getAttribute("sandbox"), "");
    assert.equal(frame.style.width, "375px");
    assert.match(t.c.textContent, /Plain-text alternative/);
    assert.equal(t.c.querySelector('[aria-label="Message body"]').value, "Original body");
    assert.match(t.c.textContent, /sends plain text only; the HTML rendering is dropped/);
    await click(t.c.querySelector('[aria-label="Phone width"]'));
    assert.equal(frame.style.width, "100%");
  } finally {
    t.close();
  }
});
test("a plain-text draft shows no HTML preview", async () => {
  const t = setup(async (url) =>
    response({
      items: String(url).includes("/api/documents") ? [] : [runtime],
      counts: { drafts: 1, cancelled: 0 },
    }),
  );
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    assert.equal(t.c.querySelector('iframe[title="HTML preview"]'), null);
    assert.doesNotMatch(t.c.textContent, /Plain-text alternative/);
  } finally {
    t.close();
  }
});
const raw = (text) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});
const bindingFor = (html) => ({
  document_id: "report-1",
  revision_id: "rev-7",
  sha256: createHash("sha256").update(html).digest("hex"),
  byte_length: Buffer.byteLength(html),
  decision_id: "decision-1",
});
const boundItem = (bound) => ({
  ...docItem,
  document: { ...docItem.document, metadata: { html_body: bound } },
});
async function settleUntil(check, tries = 40) {
  for (let i = 0; i < tries && !check(); i += 1) await settle();
}
test("a prepared email bound to an approved HTML revision previews exactly that revision beside its plain text", async () => {
  const html = "<!doctype html><html><body><p>Approved report, revision 7</p></body></html>";
  const reads = [];
  const t = setup(async (url) => {
    const u = new URL(url, "http://localhost");
    if (u.pathname === "/api/documents/report-1/raw") {
      reads.push(u.search);
      return raw(html);
    }
    return response({
      items: u.pathname.includes("/api/documents") ? [boundItem(bindingFor(html))] : [],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    await settleUntil(() => t.c.querySelector('iframe[title="HTML preview"]'));
    assert.deepEqual(reads, ["?revision=rev-7"]);
    const frame = t.c.querySelector('iframe[title="HTML preview"]');
    assert.ok(frame, "the bound revision is previewed");
    assert.equal(frame.getAttribute("srcdoc"), html);
    assert.equal(frame.getAttribute("sandbox"), "");
    assert.match(t.c.textContent, /Plain-text alternative/);
    assert.equal(t.c.querySelector('[aria-label="Message body"]').value, "Exact text");
    assert.match(t.c.textContent, /re-verifies that approval and the exact revision/);
    assert.equal(t.c.querySelector('[role="alert"]'), null);
  } finally {
    t.close();
  }
});
test("a bound HTML revision whose bytes differ from the approval is reported, never previewed", async () => {
  const approved = "<!doctype html><html><body><p>Approved report</p></body></html>";
  const served = "<!doctype html><html><body><p>Approved report.</p></body></html>";
  const t = setup(async (url) => {
    const u = new URL(url, "http://localhost");
    if (u.pathname === "/api/documents/report-1/raw") return raw(served);
    return response({
      items: u.pathname.includes("/api/documents") ? [boundItem(bindingFor(approved))] : [],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    await settleUntil(() => t.c.querySelector('[role="alert"]'));
    const alert = t.c.querySelector('[role="alert"]');
    assert.ok(alert, "the mismatch is reported");
    assert.match(alert.textContent, /bytes where the approval names|differ from the approved binding/);
    assert.match(alert.textContent, /will not send a part that fails it/);
    assert.equal(t.c.querySelector('iframe[title="HTML preview"]'), null);
    assert.doesNotMatch(t.c.textContent, /Plain-text alternative/);
  } finally {
    t.close();
  }
});
test("a prepared email without a bound HTML part reads no revision", async () => {
  const reads = [];
  const t = setup(async (url) => {
    const u = new URL(url, "http://localhost");
    if (u.pathname.endsWith("/raw")) reads.push(u.pathname);
    return response({
      items: u.pathname.includes("/api/documents") ? [docItem] : [],
      counts: { drafts: 1, cancelled: 0 },
    });
  });
  try {
    await settle();
    await click(t.c.querySelector("[data-draft-id]"));
    await settle();
    assert.deepEqual(reads, []);
    assert.equal(t.c.querySelector('iframe[title="HTML preview"]'), null);
    assert.doesNotMatch(t.c.textContent, /Loading the approved HTML part/);
  } finally {
    t.close();
  }
});
