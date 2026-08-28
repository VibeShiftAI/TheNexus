// The resync merge is untouched by the composer-isolation work — this pins
// its contract: dedup by id and by (role, content), chronological insertion
// of missed messages, id-less optimistic sends sinking to the newest end.
import test from "node:test";
import assert from "node:assert/strict";

import { mergeFetchedMessages } from "../src/components/cortex-provider.tsx";

const at = (iso) => new Date(iso);

test("missed messages merge into chronological position, duplicates dropped", () => {
    const held = [
        { id: "a", role: "user", content: "first", timestamp: at("2026-08-28T10:00:00Z") },
        { id: "c", role: "assistant", content: "third", timestamp: at("2026-08-28T10:02:00Z") },
    ];
    const fetched = [
        { id: "a", role: "user", content: "first", timestamp: at("2026-08-28T10:00:00Z") },
        { id: "b", role: "assistant", content: "missed reply", timestamp: at("2026-08-28T10:01:00Z") },
        { id: "c", role: "assistant", content: "third", timestamp: at("2026-08-28T10:02:00Z") },
    ];
    const merged = mergeFetchedMessages(held, fetched);
    assert.deepEqual(merged.map((m) => m.id), ["a", "b", "c"], "missed message lands mid-list, no duplicates");
});

test("optimistic id-less copies are not duplicated and unchanged lists return the same array", () => {
    const optimistic = { role: "user", content: "in flight", timestamp: at("2026-08-28T10:03:00Z") };
    const held = [
        { id: "a", role: "user", content: "first", timestamp: at("2026-08-28T10:00:00Z") },
        optimistic,
    ];
    const fetched = [
        { id: "srv-1", role: "user", content: "in flight", timestamp: at("2026-08-28T10:03:00Z") },
    ];
    const merged = mergeFetchedMessages(held, fetched);
    assert.equal(merged.filter((m) => m.content === "in flight").length, 1, "optimistic copy deduped by (role, content)");

    const unchanged = mergeFetchedMessages(held, held.slice(0, 1));
    assert.equal(unchanged, held, "no additions → same array identity (no re-render)");
});
