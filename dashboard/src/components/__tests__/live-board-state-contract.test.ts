/**
 * Contract test for the event→domain map (ticket D-1, the risk the Phase 2
 * design called out first).
 *
 * `EVENT_DOMAINS` is hand-written. If Praxis adds a stream event type and
 * nobody adds a case, the old `switch` fell through to `default → ["activity"]`
 * and every non-activity surface silently went back to being a plain poller —
 * stale data, no error, nothing in a log. The type system catches that only
 * when the vendored `@praxis/contract` types are regenerated; this test checks
 * the RUNTIME zod union, which is the shape actually on the wire.
 *
 * If this fails: a new event type exists. Decide which domains it invalidates
 * and add it to `EVENT_DOMAINS` — do not widen the test.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { StreamEventSchema } from "@praxis/contract";
import {
    EVENT_DOMAINS,
    LIVE_DOMAINS,
    domainsForEvent,
} from "../live-board-state-logic";

/** Every `type` literal in the discriminated union, read from the schema. */
function contractEventTypes(): string[] {
    const options = (StreamEventSchema as unknown as { options: unknown[] }).options;
    assert.ok(Array.isArray(options) && options.length > 0, "StreamEventSchema exposes no options");
    return options.map((opt) => {
        const literal = (opt as { shape: { type: { value: string } } }).shape.type.value;
        assert.equal(typeof literal, "string", "union member has no literal `type`");
        return literal;
    });
}

test("every StreamEvent type has an explicit domain mapping", () => {
    const missing = contractEventTypes().filter(
        (type) => !Object.prototype.hasOwnProperty.call(EVENT_DOMAINS, type),
    );
    assert.deepEqual(
        missing,
        [],
        `stream event types with no case in EVENT_DOMAINS: ${missing.join(", ")}`,
    );
});

test("EVENT_DOMAINS has no entries the contract does not define", () => {
    const known = new Set(contractEventTypes());
    const stale = Object.keys(EVENT_DOMAINS).filter((type) => !known.has(type));
    assert.deepEqual(stale, [], `EVENT_DOMAINS maps types the contract dropped: ${stale.join(", ")}`);
});

test("every mapped domain is a real LiveDomain", () => {
    const domains = new Set<string>(LIVE_DOMAINS);
    for (const [type, mapped] of Object.entries(EVENT_DOMAINS)) {
        assert.ok(Array.isArray(mapped), `${type} maps to a non-array`);
        for (const d of mapped) {
            assert.ok(domains.has(d), `${type} maps to unknown domain "${d}"`);
        }
    }
});

test("unknown event types still bump activity rather than nothing", () => {
    // Forward compatibility: a newer Praxis than this build must not freeze
    // the feed. It is the only case allowed to fall back.
    assert.deepEqual(domainsForEvent("something.new"), ["activity"]);
});

test("heartbeat invalidates nothing and stream.reset invalidates everything", () => {
    assert.deepEqual(domainsForEvent("heartbeat"), []);
    assert.deepEqual(domainsForEvent("stream.reset"), LIVE_DOMAINS);
});
