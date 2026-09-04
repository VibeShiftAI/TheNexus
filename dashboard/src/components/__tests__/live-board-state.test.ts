import test from "node:test";
import assert from "node:assert/strict";

import type { StreamEvent } from "@praxis/contract";
import {
    EMPTY_FRAME_STATE,
    LIVE_DOMAINS,
    MAX_RECENT_EVENTS,
    applyFrame,
    createFrameDeduper,
    domainsForEvent,
    type LiveFrameState,
} from "../live-board-state-logic";

const frame = (type: string, eventId?: string, extra: Record<string, unknown> = {}) =>
    ({ type, eventId, ts: "2026-09-03T00:00:00Z", ...extra }) as unknown as StreamEvent;

/**
 * The provider's applier in miniature: dedupe first, reduce second — exactly
 * the two calls LiveBoardStateProvider makes per frame on either transport.
 */
function makeApplier() {
    const seen = createFrameDeduper();
    let state: LiveFrameState = EMPTY_FRAME_STATE;
    let clock = 1000;
    return {
        get state() {
            return state;
        },
        apply(event: StreamEvent, viaSocket: boolean) {
            if (!seen((event as { eventId?: string }).eventId)) return false;
            clock += 1;
            state = applyFrame(state, event, viaSocket, () => clock);
            return true;
        },
    };
}

test("events without an eventId cannot be deduped: a double delivery double-bumps (harmlessly)", () => {
    const live = makeApplier();
    assert.equal(live.apply(frame("task.updated"), true), true);
    assert.equal(live.apply(frame("task.updated"), false), true, "the SSE copy is applied too");
    assert.equal(live.state.revisions.board, 2);
    assert.equal(live.state.revisions.task, 2);
    assert.equal(live.state.recentEvents.length, 2);
    // Harmless: a spare bump only means a spare refetch, never a missed one.
    assert.equal(live.state.revisions.schedule, 0);
});

test("a duplicate eventId across transports bumps once, whichever transport is first", () => {
    const socketFirst = makeApplier();
    assert.equal(socketFirst.apply(frame("task.completed", "e1"), true), true);
    assert.equal(socketFirst.apply(frame("task.completed", "e1"), false), false, "SSE copy dropped");
    assert.deepEqual(socketFirst.state.revisions, { board: 1, task: 1, schedule: 1, system: 0, activity: 1, hitl: 0, dispatch: 1, council: 0 });
    assert.equal(socketFirst.state.recentEvents.length, 1);

    const sseFirst = makeApplier();
    assert.equal(sseFirst.apply(frame("task.completed", "e1"), false), true);
    assert.equal(sseFirst.apply(frame("task.completed", "e1"), true), false, "socket copy dropped");
    assert.deepEqual(sseFirst.state.revisions, socketFirst.state.revisions);
    assert.equal(sseFirst.state.lastSocketEventAt, 0, "a dropped socket copy does not stamp the socket clock");
});

test("the dedupe set is bounded: after MAX ids the oldest is forgotten", () => {
    const seen = createFrameDeduper(3);
    assert.equal(seen("a"), true);
    assert.equal(seen("b"), true);
    assert.equal(seen("c"), true);
    assert.equal(seen("a"), false, "still remembered");
    assert.equal(seen("d"), true, "evicts a");
    assert.equal(seen("a"), true, "a was evicted, so it is new again (and evicts b)");
    assert.equal(seen("c"), false, "c is still inside the window");
    assert.equal(seen("d"), false, "so is d");
});

test("per-domain revisions are monotonic and only the invalidated domains move", () => {
    const live = makeApplier();
    const sequence: Array<[string, string]> = [
        ["presence.changed", "p1"],
        ["task.created", "t1"],
        ["heartbeat", "h1"],
        ["schedule.updated", "s1"],
        ["council.update", "c1"],
        ["something.new", "x1"],
        ["task.failed", "t2"],
        ["stream.reset", "r1"],
    ];
    let prev = { ...live.state.revisions };
    for (const [type, id] of sequence) {
        live.apply(frame(type, id), true);
        const next = live.state.revisions;
        const bumped = domainsForEvent(type);
        for (const d of LIVE_DOMAINS) {
            const expected = prev[d] + (bumped.includes(d) ? 1 : 0);
            assert.equal(next[d], expected, `${type}: ${d} ${prev[d]} → ${next[d]}`);
            assert.ok(next[d] >= prev[d], `${d} never decreases`);
        }
        prev = { ...next };
    }
    // stream.reset bumped everything; the totals reflect every frame above.
    assert.deepEqual(live.state.revisions, { board: 4, task: 3, schedule: 3, system: 2, activity: 7, hitl: 1, dispatch: 2, council: 2 });
});

test("heartbeats bump nothing and stay out of the ring; the ring is capped", () => {
    const live = makeApplier();
    live.apply(frame("heartbeat", "h0"), true);
    assert.deepEqual(live.state.revisions, EMPTY_FRAME_STATE.revisions);
    assert.equal(live.state.recentEvents.length, 0);
    assert.equal(live.state.lastSocketEventAt, 1001, "…but a heartbeat still proves the socket is alive");

    for (let i = 0; i < MAX_RECENT_EVENTS + 10; i += 1) live.apply(frame("task.updated", `u${i}`), true);
    assert.equal(live.state.recentEvents.length, MAX_RECENT_EVENTS);
    assert.equal((live.state.recentEvents[0] as { eventId?: string }).eventId, `u${MAX_RECENT_EVENTS + 9}`, "newest first");
});

test("a presence.changed frame updates the presence snapshot; the reducer never mutates its input", () => {
    const before: LiveFrameState = { ...EMPTY_FRAME_STATE, revisions: { ...EMPTY_FRAME_STATE.revisions } };
    const snapshot = JSON.stringify(before);
    const presence = { state: "thinking" };
    const after = applyFrame(before, frame("presence.changed", "p1", { presence }), false, () => 5);
    assert.deepEqual(after.presence, presence);
    assert.equal(after.lastSocketEventAt, 0, "SSE frames do not stamp the socket clock");
    assert.equal(JSON.stringify(before), snapshot, "input state untouched");
    assert.notEqual(after.revisions, before.revisions, "a bump produces a new revisions object");
});
