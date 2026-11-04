import test from "node:test";
import assert from "node:assert/strict";
import { suggestionHighlight } from "../suggestion-highlight";
const comment = (start: number, end: number, original: string) =>
  ({
    id: "c",
    revision_id: "v1",
    suggestion: {
      id: "s",
      start,
      end,
      original,
      proposed: "new",
      explanation: "reason",
    },
  }) as any;
test("maps exact CRLF offsets and refuses stale ambiguous targets", () => {
  const base = { revisionId: "v1", content: "One\r\nTwo Two" };
  assert.deepEqual(
    suggestionHighlight(comment(9, 12, "Two"), "One\nTwo Two", "v1", base)
      .target,
    { start: 8, end: 11, original: "Two" },
  );
  assert.equal(
    suggestionHighlight(comment(9, 12, "Two"), "Two Two", "v2", base).target,
    null,
  );
  assert.equal(
    suggestionHighlight(comment(0, 3, "bad"), base.content, "v1", base).target,
    null,
  );
});
test("current immutable source highlights without protected detail only on an exact range match", () => {
  assert.deepEqual(
    suggestionHighlight(comment(4, 8, "text"), "Old text", "v1").target,
    { start: 4, end: 8, original: "text" },
  );
  assert.equal(
    suggestionHighlight(comment(4, 8, "text"), "Old text", "v2").target,
    null,
  );
  assert.equal(
    suggestionHighlight(comment(4, 8, "text"), "Old changed", "v1").target,
    null,
  );
});
