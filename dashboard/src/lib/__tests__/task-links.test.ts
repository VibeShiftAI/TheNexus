import test from "node:test";
import assert from "node:assert/strict";

import {
  internalHref,
  isInternalHref,
  isTaskHref,
  isTaskId,
  remarkTaskLinks,
  splitOnTaskIds,
  taskHref,
  type TaskIdSegment,
} from "../task-links.ts";

const ID = "fd648080-df4b-4bfb-8596-9eecc8b96cb6";
const OTHER_ID = "d367be53-744b-423c-901c-6e2d43ee06fc";

test("task ids route to the task screen", () => {
  assert.equal(taskHref(ID), `/task/${ID}`);
  assert.ok(isTaskHref(taskHref(ID)));
  assert.ok(!isTaskHref("https://example.com/task/x"));
  assert.ok(isTaskId(ID));
  assert.ok(!isTaskId("not-an-id"));
});

test("inbox links from Praxis notices are in-app routes", () => {
  assert.ok(isInternalHref("/inbox"));
  assert.ok(isInternalHref("/inbox#day-schedule-2026-08-30-abc"));
  assert.ok(isInternalHref(taskHref(ID)));
  assert.ok(!isInternalHref("https://example.com/inbox"));
  assert.ok(!isInternalHref(undefined));
});

test("prose without an id is returned untouched", () => {
  const segments = splitOnTaskIds("QA passed (codex). Next up: the eval harness.");
  assert.deepEqual(segments, [
    { type: "text", value: "QA passed (codex). Next up: the eval harness." },
  ]);
});

test("every mention in a line is split out", () => {
  const segments = splitOnTaskIds(`Task ${ID} blocks ${OTHER_ID}.`);
  assert.deepEqual(segments, [
    { type: "text", value: "Task " },
    { type: "taskId", id: ID },
    { type: "text", value: " blocks " },
    { type: "taskId", id: OTHER_ID },
    { type: "text", value: "." },
  ]);
});

test("ids belonging to something other than a task stay plain text", () => {
  const relay = `Call \`git_get_diff\` with project_id="${ID}", task_id="${OTHER_ID}"`;
  const segments = splitOnTaskIds(relay);
  const linked = segments.filter((s): s is Extract<TaskIdSegment, { type: "taskId" }> => s.type === "taskId");
  assert.deepEqual(linked, [{ type: "taskId", id: OTHER_ID }]);
  assert.equal(segments.map((s) => (s.type === "text" ? s.value : s.id)).join(""), relay);
});

test("an id embedded in a longer token is not a mention", () => {
  assert.deepEqual(splitOnTaskIds(`x${ID}`), [{ type: "text", value: `x${ID}` }]);
  assert.deepEqual(splitOnTaskIds(`${ID}-extra`), [{ type: "text", value: `${ID}-extra` }]);
});

// ── remark plugin ──

function transform(tree: any) {
  remarkTaskLinks()(tree);
  return tree;
}

test("a Praxis event card's inline-code id becomes a link around the code span", () => {
  const tree = transform({
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "strong", children: [{ type: "text", value: "Task:" }] },
          { type: "text", value: " " },
          { type: "inlineCode", value: ID },
        ],
      },
    ],
  });

  const link = tree.children[0].children[2];
  assert.equal(link.type, "link");
  assert.equal(link.url, `/task/${ID}`);
  assert.equal(link.title, `Open task ${ID}`);
  assert.deepEqual(link.children, [{ type: "inlineCode", value: ID }]);
});

test("ids in prose become links, nested to any depth", () => {
  const tree = transform({
    type: "root",
    children: [
      {
        type: "list",
        children: [
          {
            type: "listItem",
            children: [
              { type: "paragraph", children: [{ type: "text", value: `Re-dispatch ${ID} now` }] },
            ],
          },
        ],
      },
    ],
  });

  const parts = tree.children[0].children[0].children[0].children;
  assert.deepEqual(parts[0], { type: "text", value: "Re-dispatch " });
  assert.equal(parts[1].type, "link");
  assert.equal(parts[1].url, `/task/${ID}`);
  assert.deepEqual(parts[1].children, [{ type: "text", value: ID }]);
  assert.deepEqual(parts[2], { type: "text", value: " now" });
});

test("code blocks and existing links are left alone", () => {
  const code = { type: "code", lang: "text", value: `task_id=${ID}` };
  const existing = {
    type: "link",
    url: "https://example.com",
    children: [{ type: "text", value: ID }],
  };
  const tree = transform({ type: "root", children: [code, { type: "paragraph", children: [existing] }] });

  assert.deepEqual(tree.children[0], { type: "code", lang: "text", value: `task_id=${ID}` });
  assert.equal(tree.children[1].children[0].url, "https://example.com");
  assert.deepEqual(tree.children[1].children[0].children, [{ type: "text", value: ID }]);
});

test("a tree with no mentions is not rewritten", () => {
  const children = [{ type: "paragraph", children: [{ type: "text", value: "All clear." }] }];
  const tree = transform({ type: "root", children });
  assert.equal(tree.children, children);
});

test("links into this dashboard collapse to in-app paths on the current origin", () => {
  const DOC = "bb977fdf-5496-48bb-98bb-031421cc9c1a";
  // The review link Praxis mints (server default NEXUS_DASHBOARD_URL) — the
  // Mac bridge app runs on localhost:3000, so opening this as a new window
  // meant a Cloudflare Access login. In-app it is just the reviewer route.
  assert.equal(internalHref(`https://nexus.vibeshiftai.com/documents/${DOC}`), `/documents/${DOC}`);
  assert.equal(internalHref(`http://localhost:3000/documents/${DOC}`), `/documents/${DOC}`);
  assert.equal(internalHref(`https://NEXUS.vibeshiftai.com/task/${ID}?tab=qa#review`), `/task/${ID}?tab=qa#review`);
  assert.equal(internalHref("https://nexus.vibeshiftai.com/"), "/");
  assert.equal(internalHref("/documents"), "/documents");
  assert.equal(internalHref(`/documents/${DOC}`), `/documents/${DOC}`);
  assert.ok(isInternalHref(`https://nexus.vibeshiftai.com/documents/${DOC}`));
  // Relative routes Praxis notices already use keep working unchanged.
  assert.equal(internalHref("/inbox#day-schedule-2026-08-30-abc"), "/inbox#day-schedule-2026-08-30-abc");
  assert.equal(internalHref(taskHref(ID)), taskHref(ID));
});

test("everything that is not a dashboard page stays a plain link", () => {
  // Other hosts, including look-alikes and the Cloudflare Access login itself.
  assert.equal(internalHref("https://github.com/x/y"), null);
  assert.equal(internalHref("https://nexus.vibeshiftai.com.evil.example/documents/x"), null);
  assert.equal(internalHref("https://vibeshiftai.cloudflareaccess.com/cdn-cgi/access/login/nexus.vibeshiftai.com"), null);
  assert.equal(internalHref("https://lab.vibeshiftai.com/p/nyc-home-finder"), null);
  assert.equal(internalHref("https://user@nexus.vibeshiftai.com/documents/x"), null);
  // Dashboard-host paths the Next client does not render (API, sockets, Cortex ingress, hub, login).
  assert.equal(internalHref("https://nexus.vibeshiftai.com/api/documents/x/raw?download=1"), null);
  assert.equal(internalHref("/api/documents/x/raw"), null);
  assert.equal(internalHref("https://nexus.vibeshiftai.com/graph/abc"), null);
  assert.equal(internalHref("https://nexus.vibeshiftai.com/runs/abc"), null);
  assert.equal(internalHref("https://nexus.vibeshiftai.com/hub/"), null);
  assert.equal(internalHref("https://nexus.vibeshiftai.com/login"), null);
  assert.equal(internalHref("/unknown-page"), null);
  // Schemes and origin-escaping shapes.
  assert.equal(internalHref("javascript:alert(1)"), null);
  assert.equal(internalHref("mailto:robert@example.com"), null);
  assert.equal(internalHref("//nexus.vibeshiftai.com/documents/x"), null);
  assert.equal(internalHref("/\\evil.example/documents/x"), null);
  assert.equal(internalHref(""), null);
  assert.equal(internalHref(undefined), null);
  assert.ok(!isInternalHref("https://example.com/inbox"));
});
