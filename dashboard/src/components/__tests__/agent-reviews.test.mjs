import test from "node:test";
import assert from "node:assert/strict";
import { previewSuggestions } from "../../lib/agent-reviews.ts";
test("combined inline preview composes only accepted edits, preserves deletion, and fails closed on overlaps", () => {
  const suggestions = [
    { id: "a", start: 0, end: 3, original: "Old", proposed: "New" },
    { id: "b", start: 4, end: 8, original: "text", proposed: "words" },
  ];
  assert.equal(
    previewSuggestions("Old text", suggestions, [
      { suggestion_id: "a", status: "rejected" },
      { suggestion_id: "b", status: "accepted", replacement: "copy" },
    ]),
    "Old copy",
  );
  assert.equal(
    previewSuggestions("Old text", suggestions, [
      { suggestion_id: "a", status: "accepted", replacement: "" },
      { suggestion_id: "b", status: "accepted" },
    ]),
    " words",
  );
  assert.throws(
    () =>
      previewSuggestions(
        "Old text",
        [
          suggestions[0],
          { id: "c", start: 1, end: 2, original: "l", proposed: "x" },
        ],
        [
          { suggestion_id: "a", status: "accepted" },
          { suggestion_id: "c", status: "accepted" },
        ],
      ),
    /overlap/,
  );
});
