import test from "node:test";
import assert from "node:assert/strict";
import { describeQuoteFailure, editableStageA, quoteWords, resolveQuote, sourceText } from "../groundrules-labeling";

// Invented statute text; nothing here is a roster passage.
const TEXT = "A card holder may borrow up to five items at one time, unless the holder has an overdue item, in which case no further loan shall be made.";

test("resolveQuote follows the scorer's anchor rule: whitespace-insensitive words, word-boundary end, exactly one match", () => {
  assert.deepEqual(resolveQuote(TEXT, "A card holder"), { ok: true, count: 1, start: 0, end: 13, slice: "A card holder" });
  assert.equal(resolveQuote(TEXT, "  A   card\nholder ").slice, "A card holder");
  assert.deepEqual(resolveQuote(TEXT, "A card hold"), { ok: false, count: 0, reason: "not_found" });
  assert.deepEqual(resolveQuote(TEXT, "The card holder"), { ok: false, count: 0, reason: "not_found" });
  assert.deepEqual(resolveQuote(TEXT, "holder"), { ok: false, count: 2, reason: "not_unique" });
  assert.equal(resolveQuote(TEXT, "item").count, 1, "'items' does not count as 'item'");
  assert.deepEqual(resolveQuote(TEXT, ""), { ok: false, count: 0, reason: "empty" });
});

test("a within span narrows the search and must itself be unique", () => {
  const pinned = resolveQuote(TEXT, "holder", "the holder has");
  assert.equal(pinned.ok, true);
  assert.equal(pinned.slice, "holder");
  assert.ok(pinned.start! > 13);
  assert.deepEqual(resolveQuote(TEXT, "holder", "no such span"), { ok: false, count: 0, reason: "within_not_found" });
  assert.deepEqual(resolveQuote(TEXT, "card", "holder"), { ok: false, count: 0, reason: "within_not_unique" });
  assert.match(describeQuoteFailure({ ok: false, count: 2, reason: "not_unique" }), /occur 2 times/);
  assert.match(describeQuoteFailure({ ok: false, count: 0, reason: "not_found" }), /do not occur/);
});

test("quoteWords and sourceText behave like the server helpers", () => {
  assert.deepEqual(quoteWords(" a  b\tc "), ["a", "b", "c"]);
  const row = { id: "r", label: "(a)", text: TEXT, anchorWithin: null, contexts: [{ quote: "For purposes of this section", sourceUnit: null, quotable: true }] };
  assert.equal(sourceText(row, "row").kind, "row");
  assert.equal(sourceText(row, 0).text, "For purposes of this section");
  assert.equal(sourceText(row, "context:0").index, 0);
  assert.equal(sourceText(row, 7).kind, "row", "an unknown context falls back to the row");
});

test("editableStageA strips derived fields and fills every editable one", () => {
  const edited = editableStageA({
    modality: "may", actor: { quote: "A card holder", source: "row", within: "" }, propositionsDeclared: "some", notes: "",
    propositions: [{ id: "p1", category: "condition", quote: "up to five items", source: "row", within: "", numeric: null, note: "", resolved: { source: "row", index: null, start: 0, end: 1, slice: "x" } }],
    actorResolved: { source: "row", index: null, start: 0, end: 13, slice: "A card holder" },
    carried_from: { session_id: "s", packet_sha256: "p", state: "complete" },
  });
  assert.equal("actorResolved" in edited, false);
  assert.equal("carried_from" in edited, false);
  assert.equal("resolved" in edited.propositions[0], false);
  assert.equal(edited.propositions[0].note, "");
  assert.deepEqual(editableStageA(null).actor, { quote: "", source: "row", within: "" });
});
