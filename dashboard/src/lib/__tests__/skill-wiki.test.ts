import test from "node:test";
import assert from "node:assert/strict";

import {
  getSkillDetail,
  getSkillIndex,
  remarkWikiLinks,
  skillHref,
  splitWikiLinks,
} from "../skill-wiki.ts";

// The slug table the API sends with a skill page. A harvested skill has a
// display name with spaces and a page at its file name; both are keys.
const SLUGS = {
  "plan-day-yourself": "plan-day-yourself",
  "qa-dispatch-and-advance": "qa-dispatch-and-advance",
  "Fold Context": "fold-context",
  "fold-context": "fold-context",
};
const KNOWN = new Map(Object.entries(SLUGS));

function answerWith(t: { mock: { method: (...args: unknown[]) => unknown } }, body: unknown) {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return Response.json(body);
  });
  return urls;
}

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
    { type: "skill", name: "plan-day-yourself", slug: "plan-day-yourself" },
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

  remarkWikiLinks(SLUGS)(tree);

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

  remarkWikiLinks(SLUGS)(tree);

  const paragraph = tree.children[0] as { children: Array<Record<string, unknown>> };
  assert.deepEqual(paragraph.children, [{ type: "inlineCode", value: "[[plan-day-yourself]]" }]);
});

test("a display-named skill is linked by its slug, whichever way the link names it", () => {
  assert.deepEqual(splitWikiLinks("Use [[fold-context]] or [[Fold Context]].", KNOWN), [
    { type: "text", value: "Use " },
    { type: "skill", name: "fold-context", slug: "fold-context" },
    { type: "text", value: " or " },
    { type: "skill", name: "Fold Context", slug: "fold-context" },
    { type: "text", value: "." },
  ]);

  const tree = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: "See [[Fold Context]]." }] }],
  };
  remarkWikiLinks(SLUGS)(tree);
  const paragraph = tree.children[0] as { children: Array<Record<string, unknown>> };
  assert.deepEqual(paragraph.children[1], {
    type: "link",
    url: "/academy/skill/fold-context",
    title: "Open skill Fold Context",
    children: [{ type: "text", value: "Fold Context" }],
  });
});

test("a wiki-link that only matches an object built-in is not a skill", () => {
  const tree = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: "[[constructor]]" }] }],
  };
  remarkWikiLinks(SLUGS)(tree);
  const paragraph = tree.children[0] as { children: Array<Record<string, unknown>> };
  assert.deepEqual(paragraph.children, [{ type: "inlineCode", value: "constructor" }]);
});

test("index rows carry the slug the Academy links by", async (t) => {
  answerWith(t, {
    total: 2,
    byCategory: { development: 1, operations: 1 },
    skills: [
      { id: "Fold Context", name: "Fold Context", slug: "fold-context" },
      { id: "plan-day", name: "plan-day", slug: "plan-day" },
    ],
  });
  const index = await getSkillIndex();
  assert.deepEqual(index.skills.map((s) => skillHref(s.slug)), [
    "/academy/skill/fold-context",
    "/academy/skill/plan-day",
  ]);
  assert.equal(index.skills[0].name, "Fold Context");
});

test("an API process that predates slugs still gets the links it could already serve", async (t) => {
  answerWith(t, { total: 1, byCategory: { operations: 1 }, skills: [{ id: "plan-day", name: "plan-day" }] });
  const index = await getSkillIndex();
  assert.equal(skillHref(index.skills[0].slug), "/academy/skill/plan-day");

  answerWith(t, {
    name: "plan-day",
    related: { inbound: ["qa-loop"], outbound: [] },
    knownSkills: ["plan-day", "qa-loop"],
  });
  const detail = await getSkillDetail("plan-day");
  assert.equal(detail.slug, "plan-day");
  assert.deepEqual(detail.skillSlugs, { "plan-day": "plan-day", "qa-loop": "qa-loop" });
});

test("a skill page is fetched by slug and keeps the slug table the API sent", async (t) => {
  const urls = answerWith(t, {
    name: "Fold Context",
    slug: "fold-context",
    related: { inbound: ["Route By Cost"], outbound: [] },
    knownSkills: ["Fold Context", "Route By Cost"],
    skillSlugs: { "Fold Context": "fold-context", "Route By Cost": "route-by-cost" },
  });
  const detail = await getSkillDetail("fold-context");
  assert.deepEqual(urls, ["/api/skill-wiki/skills/fold-context"]);
  assert.equal(detail.name, "Fold Context");
  assert.equal(detail.skillSlugs["Route By Cost"], "route-by-cost");
});
