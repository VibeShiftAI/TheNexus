import test from "node:test";
import assert from "node:assert/strict";

import { getPresenceVisualState } from "../presence-indicator";

test("getPresenceVisualState gives thinking an animated live core", () => {
  const state = getPresenceVisualState("thinking", true);

  assert.equal(state.label, "Thinking");
  assert.match(state.coreClass, /bg-sky-400/);
  assert.match(state.motionClass, /animate-\[spin_1\.1s_linear_infinite\]/);
  assert.match(state.markerClass, /bg-violet-300/);
  assert.equal(state.connectionLabel, "live");
});

test("getPresenceVisualState gives executing a faster distinct scanner", () => {
  const thinking = getPresenceVisualState("thinking", true);
  const executing = getPresenceVisualState("executing", true);

  assert.notEqual(executing.motionClass, thinking.motionClass);
  assert.match(executing.motionClass, /animate-\[spin_0\.65s_linear_infinite\]/);
  assert.match(executing.markerClass, /bg-lime-200/);
});

test("getPresenceVisualState makes disconnected state explicit", () => {
  const state = getPresenceVisualState("idle", false);

  assert.equal(state.connectionLabel, "reconnecting");
  assert.match(state.connectionClass, /border-amber-400/);
});
