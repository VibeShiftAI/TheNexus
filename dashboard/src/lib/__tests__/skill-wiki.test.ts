import test from "node:test";
import assert from "node:assert/strict";

import {
  remarkWikiLinks,
  skillHref,
  splitWikiLinks,
} from "../skill-wiki.ts";

const KNOWN = ["plan-day-yourself", "qa-dispatch-and-advance"];

test("skill names route to their wiki page", () => {
  assert.equal(skillHref("plan-day-yourself"), "/academy/skill/plan-day-yourself");
});

test("prose without a wiki-link is returned untouched", () => {
  assert.deepEqual(splitWikiLinks("Follow the linked manifest.", KNOWN), [
    { type: "text", value: "Follow the linked manifest." },
  ]);
});

test("known skills navigate, unknown refs degrade to vault references", () => {
  const segments = splitWikiLinks(
    "See [[plan-day-yourself]] and [[feedback_no_synthetic_qa_gates]] first.",
    KNOWN,
  );
  assert.deepEqual(segments, [
    { type: "text", value: "See " },
    { type: "skill", name: "plan-day-yourself" },
    { type: "text", value: " and " },
    { type: "vaultRef", name: "feedback_no_synthetic_qa_gates" },
    { type: "text", value: " first." },
  ]);
});

test("remarkWikiLinks rewrites mdast text into links and inline code", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: "Mirrors [[qa-dispatch-and-advance]] via [[note_day_planning]]." },
        ],
      },
    ],
  };

  remarkWikiLinks(KNOWN)(tree);

  const paragraph = tree.children[0] as { children: Array<Record<string, unknown>> };
  assert.deepEqual(paragraph.children, [
    { type: "text", value: "Mirrors " },
    {
      type: "link",
      url: "/academy/skill/qa-dispatch-and-advance",
      title: "Open skill qa-dispatch-and-advance",
      children: [{ type: "text", value: "qa-dispatch-and-advance" }],
    },
    { type: "text", value: " via " },
    { type: "inlineCode", value: "note_day_planning" },
    { type: "text", value: "." },
  ]);
});

test("wiki-links inside code spans are left alone", () => {
  const tree = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "inlineCode", value: "[[plan-day-yourself]]" }],
      },
    ],
  };

  remarkWikiLinks(KNOWN)(tree);

  const paragraph = tree.children[0] as { children: Array<Record<string, unknown>> };
  assert.deepEqual(paragraph.children, [{ type: "inlineCode", value: "[[plan-day-yourself]]" }]);
});
