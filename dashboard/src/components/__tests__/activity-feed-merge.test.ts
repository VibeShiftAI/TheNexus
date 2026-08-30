import test from "node:test";
import assert from "node:assert/strict";

import { mergeActivityRows } from "../activity-feed";
import type { Activity, ActivityEvent } from "@/lib/nexus";

function commit(hash: string, date: string): Activity {
    return {
        projectId: "praxis", projectName: "Praxis", type: "commit",
        hash, message: `commit ${hash}`, author: "Robert", date,
    };
}

function event(id: number, created_at: string, over: Partial<ActivityEvent> = {}): ActivityEvent {
    return {
        id, event_type: "qa_dispatched", severity: "info", title: "QA review dispatched",
        message: null, task_id: null, source: "praxis:qa-dispatch", metadata: {},
        requires_action: 0, created_at, ...over,
    };
}

test("commits and Praxis events interleave on one newest-first timeline", () => {
    const rows = mergeActivityRows(
        [commit("aaa1111", "2026-08-30T10:00:00Z"), commit("bbb2222", "2026-08-30T08:00:00Z")],
        [event(1, "2026-08-30T11:00:00Z"), event(2, "2026-08-30T09:00:00Z")],
        "all",
    );

    assert.deepEqual(
        rows.map(r => `${r.kind}:${r.kind === "commit" ? r.commit.hash : r.event.id}`),
        ["event:1", "commit:aaa1111", "event:2", "commit:bbb2222"],
    );
});

test("SQLite timestamps are read as UTC, not local time", () => {
    // The event relay writes "YYYY-MM-DD HH:MM:SS" with no zone. Read naively
    // that lands hours off and events sort into the wrong day.
    const rows = mergeActivityRows(
        [commit("aaa1111", "2026-08-30T10:30:00Z")],
        [event(1, "2026-08-30 10:00:00")],
        "all",
    );

    assert.deepEqual(rows.map(r => r.kind), ["commit", "event"]);
    assert.equal(rows[1].at, Date.parse("2026-08-30T10:00:00Z"));
});

test("each tab shows only its own half", () => {
    const commits = [commit("aaa1111", "2026-08-30T10:00:00Z")];
    const events = [event(1, "2026-08-30T11:00:00Z")];

    assert.deepEqual(mergeActivityRows(commits, events, "events").map(r => r.kind), ["event"]);
    assert.deepEqual(mergeActivityRows(commits, events, "commits").map(r => r.kind), ["commit"]);
});

test("rows carry stable keys and the feed is bounded", () => {
    const events = Array.from({ length: 80 }, (_, i) =>
        event(i, new Date(Date.UTC(2026, 7, 30, 0, i)).toISOString()));
    const rows = mergeActivityRows([], events, "all");

    assert.equal(rows.length, 60);
    assert.equal(new Set(rows.map(r => r.key)).size, 60);
    // Newest kept, oldest dropped.
    assert.equal(rows[0].key, "e-79");
});
