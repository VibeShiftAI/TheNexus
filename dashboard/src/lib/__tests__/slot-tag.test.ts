import test from "node:test";
import assert from "node:assert/strict";

import { displayEventTitle, slotTag, withSlotTag } from "../slot-tag.ts";

test("the tag is S and the number, and a task with no number has none", () => {
  assert.equal(slotTag(7), "S7");
  assert.equal(slotTag(null), null);
  assert.equal(slotTag(undefined), null);
  assert.equal(slotTag(1.5), null);
});

test("a title carries its tag once, and an unnumbered title stays bare", () => {
  assert.equal(withSlotTag("Ship it", 7), "S7 · Ship it");
  assert.equal(withSlotTag("S7 · Ship it", 7), "S7 · Ship it");
  assert.equal(withSlotTag("Ship it", undefined), "Ship it");
});

test("a title that merely starts like a tag is not taken for one", () => {
  assert.equal(withSlotTag("S3 bucket cleanup", 7), "S7 · S3 bucket cleanup");
  assert.equal(displayEventTitle("S3 bucket cleanup"), "S3 bucket cleanup");
});

test("titles stored before day numbering read the new way", () => {
  assert.equal(displayEventTitle("[Slot 3] Old plan work"), "S3 · Old plan work");
  assert.equal(displayEventTitle("[Ad-hoc] Old chat work"), "Old chat work");
  assert.equal(displayEventTitle("S8 · New work"), "S8 · New work");
});
