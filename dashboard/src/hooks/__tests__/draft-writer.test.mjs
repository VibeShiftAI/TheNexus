import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { useDraftWriter } from "../use-draft-writer.ts";
test("rapid drafts coalesce; pagehide and navigation flush the exact latest value", async () => {
  const writes = [];
  let save;
  function Harness({ id }) {
    save = useDraftWriter(
      id,
      (key, value) => writes.push({ key, value }),
      10000,
    );
    return null;
  }
  const c = document.createElement("div");
  const root = createRoot(c);
  try {
    act(() => root.render(createElement(Harness, { id: "one" })));
    save("a");
    save("ab");
    save("abc");
    assert.equal(writes.length, 0);
    window.dispatchEvent(new window.Event("pagehide"));
    assert.deepEqual(writes, [{ key: "one", value: "abc" }]);
    save("last");
    act(() => root.render(createElement(Harness, { id: "two" })));
    assert.deepEqual(writes.at(-1), { key: "one", value: "last" });
    save("two draft");
  } finally {
    act(() => root.unmount());
  }
  assert.deepEqual(writes.at(-1), { key: "two", value: "two draft" });
});
