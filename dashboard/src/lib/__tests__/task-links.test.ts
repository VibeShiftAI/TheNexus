import test from "node:test";
import assert from "node:assert/strict";

import {
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
