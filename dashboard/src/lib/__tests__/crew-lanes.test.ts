import test from "node:test";
import assert from "node:assert/strict";

import { ORPHAN_LANE_TTL_MS, REDISPATCH_GRACE_MS, laneSupersededByRegistry } from "../crew-lanes";

const T0 = Date.parse("2026-10-03T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const active = (at = T0) => ({ taskId: "task-a", status: "active" as const, at });

test("the registry closing the run (at or after the lane's frame) supersedes an active lane: no phantom run after a missed task.completed", () => {
    const registry = [{ taskId: "task-a", executor: "codex", status: "done", updatedAt: iso(T0 + 60_000) }];
    assert.equal(laneSupersededByRegistry(active(), "codex", registry, T0 + 120_000), true);
    // The same task, recorded under another executor name, still counts.
    assert.equal(laneSupersededByRegistry(active(), "claude-code", registry, T0 + 120_000), true);
});

test("a registry record that is still active confirms the lane", () => {
    const registry = [{ taskId: "task-a", executor: "codex", status: "active", updatedAt: iso(T0 + 60_000) }];
    assert.equal(laneSupersededByRegistry(active(), "codex", registry, T0 + 3 * 3_600_000), false, "a long run stays live as long as the registry says so");
});

test("a registry record closed BEFORE the lane's frame (beyond the grace) is an older attempt: the newer stream frame wins", () => {
    const registry = [{ taskId: "task-a", executor: "codex", status: "failed", updatedAt: iso(T0 - REDISPATCH_GRACE_MS - 1_000) }];
    assert.equal(laneSupersededByRegistry(active(), "codex", registry, T0 + 1_000), false);
    // Inside the grace the ordering is not trusted and the registry's close wins.
    const close = [{ taskId: "task-a", executor: "codex", status: "failed", updatedAt: iso(T0 - REDISPATCH_GRACE_MS + 1_000) }];
    assert.equal(laneSupersededByRegistry(active(), "codex", close, T0 + 1_000), true);
});

test("a closed registry record without any timestamp is still authoritative", () => {
    assert.equal(laneSupersededByRegistry(active(), "codex", [{ taskId: "task-a", executor: "codex", status: "done" }], T0), true);
});

test("a lane the registry has never heard of is trusted while young and dropped once silent past the orphan TTL", () => {
    const registry = [{ taskId: "other", executor: "codex", status: "active", updatedAt: iso(T0) }];
    assert.equal(laneSupersededByRegistry(active(), "codex", registry, T0 + 30_000), false, "the frame beat the registry write");
    assert.equal(laneSupersededByRegistry(active(), "codex", registry, T0 + ORPHAN_LANE_TTL_MS), false, "at the edge, still kept");
    assert.equal(laneSupersededByRegistry(active(), "codex", registry, T0 + ORPHAN_LANE_TTL_MS + 1), true, "silent too long: the closing frame was missed");
    assert.equal(laneSupersededByRegistry(active(), "codex", [], T0 + ORPHAN_LANE_TTL_MS + 1), true, "an empty registry (no runs at all) is also an answer");
});

test("without any registry snapshot (never loaded, every fetch failed) the stream's word stands; settled lanes are never the registry's business", () => {
    assert.equal(laneSupersededByRegistry(active(), "codex", null, T0 + 24 * 3_600_000), false);
    assert.equal(laneSupersededByRegistry({ taskId: "task-a", status: "done", at: T0 }, "codex", [], T0 + 1), false);
    assert.equal(laneSupersededByRegistry({ taskId: "task-a", status: "failed", at: T0 }, "codex", [{ taskId: "task-a", executor: "codex", status: "active" }], T0 + 1), false);
});
