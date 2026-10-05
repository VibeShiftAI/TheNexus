/**
 * The merge that puts chat-dispatched work on Today's Schedule
 * (lib/schedule-live-work.ts): no-plan + queue, dedupe against calendar
 * events, dependency rows, lane transitions, the stale/unavailable read
 * states, and the local-midnight window. Pure, no DOM.
 *
 * Fixtures mirror the live snapshot of 2026-10-04 21:33 (ids shortened): the
 * visibility task held the slot, two queued behind it, each with a linked
 * successor, and nothing on the calendar for any of them.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { CalendarEvent } from "../calendar";
import type { LiveWorkItem, LiveWorkResponse } from "../nexus/dispatch-insight";
import {
  applyLiveWorkRead,
  INITIAL_LIVE_WORK_READ,
  liveItemLabel,
  liveWorkAvailability,
  liveWorkAvailabilityText,
  mergeLiveWork,
} from "../schedule-live-work";

const DAY = 24 * 3600_000;
/** Local midnight of 2026-10-04 and the two-day window the timeline fetches. */
const T0 = new Date(2026, 9, 4, 0, 0, 0, 0).getTime();
const WINDOW = { start: T0, end: T0 + 2 * DAY };
const at = (hours: number, minutes = 0) => new Date(T0 + hours * 3600_000 + minutes * 60_000).toISOString();

function event(partial: Partial<CalendarEvent> & { id: string; title: string; start_time: string }): CalendarEvent {
  return {
    end_time: null,
    description: null,
    result: null,
    status: "scheduled",
    event_type: "praxis_task",
    project_id: null,
    task_id: null,
    model_assignment: null,
    created_at: null,
    updated_at: null,
    ...partial,
  };
}

const RUNNING: LiveWorkItem = {
  taskId: "visibility", title: "Show chat-dispatched work in Today’s Schedule", lane: "running",
  executor: "claude-code", phase: "testing", startedAt: at(17, 32), boardStatus: "in_progress",
};
const QUEUED_1: LiveWorkItem = {
  taskId: "approvals", title: "Enable executor-recorded document approvals", lane: "queued",
  executor: "claude-code", enqueuedAt: at(15, 51), position: 1, queueLength: 2, correction: true,
  boardStatus: "todo", statusMessage: "QA failed — corrections required",
};
const QUEUED_2: LiveWorkItem = {
  taskId: "contract-fix", title: "Honor Robert-originated task contract changes", lane: "queued",
  executor: "claude-code", enqueuedAt: at(17, 32), position: 2, queueLength: 2, correction: false, boardStatus: "todo",
};
const WAITING: LiveWorkItem = {
  taskId: "contract-successor", title: "Carry contract decisions through dispatch", lane: "waiting",
  boardStatus: "idea", autoStart: true,
  waitingOn: [{ taskId: "contract-fix", title: QUEUED_2.title, lane: "queued", position: 2 }],
};
const IN_QA: LiveWorkItem = {
  taskId: "unreviewed", title: "Latest document revision repair", lane: "qa",
  startedAt: at(15, 46), finishedAt: at(15, 50), boardStatus: "in_progress",
  qa: { executor: "codex", startedAt: at(15, 50), status: "active" },
};
const DONE_TODAY: LiveWorkItem = {
  taskId: "done-today", title: "Restore document review saves", lane: "finished",
  startedAt: at(14, 12), finishedAt: at(14, 19), outcome: "completed", boardStatus: "completed",
};

function response(items: LiveWorkItem[], atIso = at(17, 33)): LiveWorkResponse {
  return { at: atIso, praxis: { reachable: true, error: null }, items };
}

test("no day plan + a queue: running work is placed at its real start, queued work keeps Praxis's order with no time, linked work waits on its named dependency", () => {
  const merged = mergeLiveWork([], response([RUNNING, QUEUED_1, QUEUED_2, WAITING]), WINDOW);

  assert.deepEqual(merged.timed.map((r) => [r.taskId, r.whenIso]), [["visibility", RUNNING.startedAt]]);
  assert.deepEqual(merged.untimed.map((r) => [r.taskId, r.lane, r.whenIso]), [
    ["approvals", "queued", null],
    ["contract-fix", "queued", null],
    ["contract-successor", "waiting", null],
  ]);
  assert.equal(merged.queuedCount, 2);
  assert.equal(merged.runningCount, 1);
  assert.equal(merged.badges.size, 0);

  assert.equal(liveItemLabel(RUNNING), "running · Claude Code · testing");
  assert.match(liveItemLabel(QUEUED_1), /^queued #1 of 2 · waiting since \d\d:\d\d(?: [AP]M)? · correction round$/);
  assert.match(liveItemLabel(QUEUED_2), /^queued #2 of 2 · waiting since /);
  assert.doesNotMatch(liveItemLabel(QUEUED_2), /correction/);
  assert.equal(
    liveItemLabel(WAITING),
    "waiting on “Honor Robert-originated task contract changes” (queued #2) · starts automatically when it completes",
  );
});

test("queue order comes from Praxis positions, not from the order items arrive in", () => {
  const merged = mergeLiveWork([], response([WAITING, QUEUED_2, QUEUED_1]), WINDOW);
  assert.deepEqual(merged.untimed.map((r) => r.taskId), ["approvals", "contract-fix", "contract-successor"]);
});

test("mixed schedule + queue: a task on the calendar and in the queue is one row — the event gets a badge, no second row", () => {
  const slot = event({ id: "slot-3", title: "Slot 3: contract fix", start_time: at(16), task_id: "contract-fix", status: "scheduled" });
  const adHoc = event({ id: "adhoc-done", title: "[Ad-hoc] Restore document review saves", start_time: at(14, 19), task_id: "done-today", status: "completed" });
  const other = event({ id: "llm", title: "Local LLM Nightly Synthesis", start_time: at(1), event_type: "local_llm:synthesis" });

  const merged = mergeLiveWork([slot, adHoc, other], response([RUNNING, QUEUED_1, QUEUED_2, DONE_TODAY]), WINDOW);

  // contract-fix: badge on its slot, not a row.
  assert.ok(!merged.untimed.some((r) => r.taskId === "contract-fix"));
  assert.equal(merged.badges.get("slot-3")?.lane, "queued");
  assert.match(merged.badges.get("slot-3")?.label ?? "", /^queued #2 of 2/);
  // done-today: already a completed calendar row — nothing to add, nothing to duplicate.
  assert.ok(!merged.timed.some((r) => r.taskId === "done-today"));
  assert.equal(merged.badges.has("adhoc-done"), false);
  // The unrelated event is untouched; the other live rows still appear once each.
  assert.equal(merged.badges.has("llm"), false);
  assert.deepEqual(merged.untimed.map((r) => r.taskId), ["approvals"]);
  assert.deepEqual(merged.timed.map((r) => r.taskId), ["visibility"]);
  assert.equal(merged.queuedCount, 2, "the count still reflects the queue, badge or row");
});

test("implementation finished is not QA passed: the QA lane says the reviewer is running; completion is claimed only from the board", () => {
  const merged = mergeLiveWork([], response([IN_QA, DONE_TODAY]), WINDOW);
  assert.deepEqual(merged.timed.map((r) => [r.taskId, r.lane, r.whenIso]), [
    ["done-today", "finished", DONE_TODAY.finishedAt],
    ["unreviewed", "qa", IN_QA.finishedAt],
  ]);
  assert.equal(liveItemLabel(IN_QA), "implementation finished · QA running (Codex)");
  assert.equal(liveItemLabel(DONE_TODAY), "completed on the board");
  assert.equal(liveItemLabel({ ...IN_QA, lane: "finished", qa: null }), "implementation finished · QA pending");
  assert.equal(
    liveItemLabel({ ...IN_QA, lane: "finished", qa: null, qaDeferred: { since: at(16), reason: "codex circuit open" } }),
    "implementation finished · QA waiting for a slot",
  );
  assert.equal(
    liveItemLabel({ ...IN_QA, lane: "finished", qa: null, boardStatus: "todo", statusMessage: "QA failed — corrections required" }),
    "implementation finished · todo · QA failed — corrections required",
  );
  assert.equal(liveItemLabel({ ...IN_QA, lane: "finished", qa: null, outcome: "failed", boardStatus: "failed" }), "run failed");
});

test("transitions: queued → running → QA → done keep exactly one row per task, and the row leaves once the calendar carries the completion", () => {
  const id = "contract-fix";
  const rowsFor = (items: LiveWorkItem[], events: CalendarEvent[] = []) => {
    const m = mergeLiveWork(events, response(items), WINDOW);
    const rows = [...m.timed, ...m.untimed].filter((r) => r.taskId === id);
    const badges = [...m.badges.values()].filter((b) => b.item.taskId === id);
    return { rows, badges };
  };

  let s = rowsFor([QUEUED_2]);
  assert.deepEqual(s.rows.map((r) => r.lane), ["queued"]);

  const running: LiveWorkItem = { ...QUEUED_2, lane: "running", startedAt: at(18), phase: "executing", position: undefined, queueLength: undefined };
  s = rowsFor([running]);
  assert.deepEqual(s.rows.map((r) => [r.lane, r.whenIso]), [["running", at(18)]]);

  const inQa: LiveWorkItem = { ...running, lane: "qa", finishedAt: at(18, 40), qa: { executor: "codex", startedAt: at(18, 41), status: "active" } };
  s = rowsFor([inQa]);
  assert.deepEqual(s.rows.map((r) => [r.lane, r.whenIso]), [["qa", at(18, 40)]]);

  const done: LiveWorkItem = { ...inQa, lane: "finished", qa: null, boardStatus: "completed" };
  s = rowsFor([done]);
  assert.deepEqual(s.rows.map((r) => r.lane), ["finished"]);
  assert.equal(liveItemLabel(done), "completed on the board");

  // The reconciler writes the [Ad-hoc] completed event: the live row folds into it.
  const adHoc = event({ id: "adhoc", title: `[Ad-hoc] ${QUEUED_2.title}`, start_time: at(18, 45), task_id: id, status: "completed" });
  s = rowsFor([done], [adHoc]);
  assert.equal(s.rows.length, 0);
  assert.equal(s.badges.length, 0);

  // Its successor stops waiting once the predecessor is gone from live work.
  const successorAfter = mergeLiveWork([adHoc], response([done]), WINDOW);
  assert.ok(!successorAfter.untimed.some((r) => r.taskId === WAITING.taskId));
});

test("local midnight: queued and waiting rows carry over, a run or a reviewer still active since yesterday stays, yesterday's finished work drops out", () => {
  const nextDay = { start: T0 + DAY, end: T0 + 3 * DAY };
  const items: LiveWorkItem[] = [
    { ...RUNNING, startedAt: at(23, 50) }, // started yesterday, still active
    QUEUED_1,
    WAITING,
    DONE_TODAY, // finished yesterday afternoon
    // Implementation finished yesterday, reviewer still running: live work,
    // not history (QA round 1 finding, 2026-10-04).
    { ...IN_QA, taskId: "late-qa", finishedAt: at(23, 58), qa: { executor: "codex", startedAt: at(23, 59), status: "active" } },
  ];
  const merged = mergeLiveWork([], response(items), nextDay);
  assert.deepEqual(merged.timed.map((r) => r.taskId), ["visibility", "late-qa"]);
  assert.deepEqual(merged.untimed.map((r) => r.taskId), ["approvals", "contract-successor"]);

  // Same items, yesterday's window: the finished rows are today's history.
  const yesterday = mergeLiveWork([], response(items), WINDOW);
  assert.deepEqual(yesterday.timed.map((r) => r.taskId), ["done-today", "visibility", "late-qa"]);
});

test("no runtime read is never 'nothing queued': unavailable before any good read, stale (with the last rows) after one", () => {
  let read = applyLiveWorkRead(INITIAL_LIVE_WORK_READ, { ok: false, error: "Live work unavailable (502)" });
  assert.deepEqual(liveWorkAvailability(read), { state: "unavailable", detail: "Live work unavailable (502)" });
  assert.match(liveWorkAvailabilityText(liveWorkAvailability(read))!, /^Runtime queue unavailable · Live work unavailable \(502\)/);
  assert.equal(read.response, null);

  const good = response([QUEUED_1, QUEUED_2]);
  read = applyLiveWorkRead(read, { ok: true, response: good });
  assert.deepEqual(liveWorkAvailability(read), { state: "live", at: good.at });
  assert.equal(liveWorkAvailabilityText(liveWorkAvailability(read)), null);

  // A 200 that carries no runtime read (Praxis down behind a healthy Nexus) is stale, not live.
  read = applyLiveWorkRead(read, { ok: true, response: { at: at(17, 40), praxis: { reachable: false, error: "Praxis dispatch-state HTTP 502" }, items: [] } });
  assert.deepEqual(liveWorkAvailability(read), { state: "stale", at: good.at, detail: "Praxis dispatch-state HTTP 502" });
  assert.equal(read.response, good, "the last good rows are kept for display");
  assert.match(liveWorkAvailabilityText(liveWorkAvailability(read))!, /^Runtime queue stale · last read \d\d:\d\d(?: [AP]M)? · Praxis dispatch-state HTTP 502$/);

  // A transport failure after a good read is stale too.
  read = applyLiveWorkRead(read, { ok: false, error: "fetch failed" });
  assert.equal(liveWorkAvailability(read).state, "stale");
  assert.equal(read.response, good);

  // Recovery returns to live with the fresh rows.
  const fresh = response([QUEUED_2], at(17, 45));
  read = applyLiveWorkRead(read, { ok: true, response: fresh });
  assert.deepEqual(liveWorkAvailability(read), { state: "live", at: fresh.at });
  assert.equal(read.response, fresh);
});

test("unscheduled board work never reads as queued: only queued-lane items count, and malformed items are ignored", () => {
  const idea: LiveWorkItem = { taskId: "plain-idea", title: "An idea", lane: "waiting", waitingOn: [] };
  const merged = mergeLiveWork([], response([idea, { taskId: "x", title: "bad", lane: "nope" as never }]), WINDOW);
  assert.equal(merged.queuedCount, 0);
  assert.deepEqual(merged.untimed.map((r) => r.taskId), ["plain-idea"]);
  assert.equal(liveItemLabel(idea), "waiting on linked work");
});

test("the queue is reported whole: a head that also has a calendar slot still leads it, and badged work still counts as work", () => {
  const slot = event({ id: "slot-approvals", title: "Slot: approvals", start_time: at(19, 0), task_id: "approvals" });
  const merged = mergeLiveWork([slot], response([QUEUED_2, QUEUED_1]), WINDOW);
  assert.deepEqual(merged.queue.map((i) => i.taskId), ["approvals", "contract-fix"], "Praxis's order, badged head included");
  assert.deepEqual(merged.untimed.map((r) => r.taskId), ["contract-fix"], "the badged head is not a second row");
  assert.equal(merged.workCount, 2);

  const onlyBadged = mergeLiveWork([slot], response([{ ...QUEUED_1, queueLength: 1 }]), WINDOW);
  assert.equal(onlyBadged.timed.length + onlyBadged.untimed.length, 0);
  assert.equal(onlyBadged.queuedCount, 1);
  assert.equal(onlyBadged.workCount, 1, "work shown only as a badge is still work");
  assert.equal(mergeLiveWork([], response([]), WINDOW).workCount, 0);
});
