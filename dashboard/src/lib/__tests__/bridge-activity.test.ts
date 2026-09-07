import test from "node:test";
import assert from "node:assert/strict";
import { deriveBridgeActivity, activityFromStream } from "../bridge-activity";
const now = Date.parse("2026-09-07T16:00:00Z");
const at = new Date(now - 1000).toISOString();
const frame = (type: string, extra = {}) =>
  ({ type, eventId: type, at, ...extra }) as any;
const base = {
  now,
  connected: true,
  events: [],
  runs: [],
  runsAvailable: true,
  knowledge: null,
};
test("QA lifecycle links to the original task and never equates run success with QA pass", () => {
  const e = activityFromStream(
    frame("task.completed", {
      taskId: "qa--task-1",
      result: {
        outcome: "success",
        executor: "codex",
        summary: "Corrections required",
      },
    }),
  )!;
  assert.equal(e.channel, "qa");
  assert.equal(e.href, "/task/task-1#qa-reviews");
  assert.equal(e.status, "recorded");
  assert.match(e.title, /Review finished/);
  assert.doesNotMatch(e.title, /passed/i);
});
test("terminal events stop registry work and replayed events do not double count", () => {
  const event = frame("task.completed", {
    taskId: "t",
    result: { outcome: "success", summary: "Done" },
  });
  const result = deriveBridgeActivity({
    ...base,
    events: [event, event],
    runs: [
      {
        taskId: "t",
        title: "Task",
        executor: "codex",
        kind: "task",
        phase: "writing",
        status: "active",
        updatedAt: new Date(now - 5000).toISOString(),
        startedAt: at,
      },
    ] as any,
  });
  assert.equal(result.channels.find((x) => x.id === "working")!.active, 0);
  assert.equal(result.items.filter((x) => x.channel === "completed").length, 1);
});
test("old progress settles, future frames never animate, and unavailable sources do not claim live activity", () => {
  const old = frame("executor.progress", {
    at: new Date(now - 600000).toISOString(),
    progress: { taskId: "t", executor: "codex", phase: "writing" },
  });
  const future = frame("task.started", {
    at: new Date(now + 600000).toISOString(),
    taskId: "future",
    executor: "codex",
  });
  const result = deriveBridgeActivity({
    ...base,
    connected: false,
    runsAvailable: false,
    events: [old, future],
  });
  assert.ok(result.channels.every((c) => !c.hot && c.active === 0));
  assert.equal(
    result.channels.find((c) => c.id === "memory")!.available,
    false,
  );
});
test("real ledger calls and file timestamps classify separately, failed calls stay failed, pulses expire", () => {
  const knowledge = {
    at,
    sources: { memory: true, vault: true },
    calls: [
      {
        id: 1,
        at,
        tool: "memory_search",
        caller: "codex",
        success: true,
        latency_ms: 20,
      },
      { id: 2, at, tool: "vault_write", caller: "codex", success: false },
    ],
    files: [{ path: "memories/note.md", at, bytes: 100 }],
  };
  const result = deriveBridgeActivity({ ...base, knowledge });
  assert.equal(result.channels.find((c) => c.id === "memory")!.hot, true);
  assert.equal(result.items.find((e) => e.id === "call:2")!.status, "failed");
  assert.match(
    result.items.find((e) => e.path)!.href!,
    /document=memories%2Fnote.md/,
  );
  const settled = deriveBridgeActivity({
    ...base,
    now: now + 60000,
    knowledge,
  });
  assert.ok(settled.channels.every((c) => !c.hot));
});
test("newer registry terminal state wins over older stream progress and old completion cannot stop a new attempt", () => {
  const progress = frame("executor.progress", {
    at: new Date(now - 10000).toISOString(),
    progress: { taskId: "t", executor: "codex", phase: "writing" },
  });
  const run = {
    taskId: "t",
    title: "Task",
    executor: "codex",
    kind: "task",
    phase: "completed",
    status: "completed",
    updatedAt: at,
    startedAt: new Date(now - 60000).toISOString(),
  };
  assert.equal(
    deriveBridgeActivity({
      ...base,
      events: [progress],
      runs: [run] as any,
    }).channels.find((c) => c.id === "working")!.active,
    0,
  );
  const completion = frame("task.completed", {
    at: new Date(now - 30000).toISOString(),
    taskId: "t",
    result: { outcome: "success" },
  });
  assert.equal(
    deriveBridgeActivity({
      ...base,
      events: [completion],
      runs: [{ ...run, status: "active", phase: "writing" }] as any,
    }).channels.find((c) => c.id === "working")!.active,
    1,
  );
});
test("agent runs open operations rather than a nonexistent task and snapshot starts populate dispatch history", () => {
  const result = deriveBridgeActivity({
    ...base,
    runs: [
      {
        taskId: "agent-a-1",
        title: "Analysis",
        executor: "codex",
        kind: "agent",
        phase: "thinking",
        status: "active",
        startedAt: at,
        updatedAt: at,
      },
    ] as any,
  });
  const item = result.items.find((e) => e.id.startsWith("run:"))!;
  assert.equal(item.href, "/ops");
  assert.equal(item.taskId, undefined);
  assert.equal(result.channels.find((c) => c.id === "dispatch")!.recent, 1);
});
